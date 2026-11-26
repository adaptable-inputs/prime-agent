//! Qwen Code's paid-subscription device grant, separate from legacy portal OAuth. The caller owns durable storage and must save each rotating token pair before checking membership.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tokio::time::Instant;

use super::{OAuthLoginUi, ProviderHttp, ProviderHttpMethod, ProviderHttpRequest};

const DEVICE_URL: &str = "https://auth.qwen.ai/api/oauth/device/code";
const TOKEN_URL: &str = "https://auth.qwen.ai/api/oauth/token";
const USERINFO_URL: &str = "https://auth.qwen.ai/api/oauth/userinfo";
const CLIENT_ID: &str = "qwen-code-cli";
const SCOPE: &str = "model:invoke profile:read";
const REQUEST_TIMEOUT_MS: u64 = 30_000;
// Keep rotating refresh requests bounded independently of the longer interactive grant.
const REFRESH_TIMEOUT_MS: u64 = 8_000;
const REFRESH_SKEW_MS: i64 = 30_000;
const CANCEL_INTERVAL: Duration = Duration::from_millis(250);
const SAFE_OAUTH_ERRORS: [&str; 12] = [
    "authorization_pending",
    "slow_down",
    "access_denied",
    "expired_token",
    "invalid_grant",
    "invalid_client",
    "invalid_request",
    "invalid_scope",
    "unsupported_grant_type",
    "temporarily_unavailable",
    "server_error",
    "invalid_token",
];

/// The only inference gateway for modern Qwen Code paid-subscription credentials.
pub const QWEN_SUBSCRIPTION_BASE_URL: &str = "https://api.qwen.ai/compatible-mode/v1";

/// The cancellation outcome mapped to a silent cancellation by the driving surface.
pub const LOGIN_CANCELLED: &str = "Login cancelled";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QwenSubscriptionCredentials {
    pub access: String,
    pub refresh: String,
    /// Wall-clock epoch milliseconds, with Qwen Code's thirty-second refresh window applied.
    pub expires: i64,
}

#[derive(Deserialize)]
struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    expires_in: f64,
    interval: f64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: f64,
    #[serde(rename = "scope")]
    _scope: String,
}

struct RequestFailure {
    code: &'static str,
    status: Option<u16>,
}

impl RequestFailure {
    fn message(&self, stage: &str) -> String {
        let code = self.code;
        let suffix = self
            .status
            .map_or_else(String::new, |status| format!(" (HTTP {status})"));
        format!("Qwen subscription: {stage}/{code}{suffix}")
    }
}

/// Acquire an independent modern Qwen Code subscription grant.
///
/// This does not check membership. Persist the complete pair before calling [`check_qwen_subscription_membership`], so an unavailable membership service cannot lose it.
///
/// # Errors
///
/// Returns [`LOGIN_CANCELLED`] when the surface cancels, or a sanitized device/exchange error.
#[tracing::instrument(skip_all)]
// Keep the device grant, cancellation race, and polling deadline together as one state machine.
#[allow(clippy::too_many_lines)]
pub async fn login_qwen_subscription(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> Result<QwenSubscriptionCredentials, String> {
    let cancelled = async {
        loop {
            if ui.is_cancelled() {
                return;
            }
            tokio::time::sleep(CANCEL_INTERVAL).await;
        }
    };
    let login = async {
        let issued_at = Instant::now();
        let device = request_json(
            http,
            form_request(DEVICE_URL, &[("client_id", CLIENT_ID), ("scope", SCOPE)]),
            REQUEST_TIMEOUT_MS,
        )
        .await
        .map_err(|error| error.message("device"))?;
        check_cancelled(ui)?;
        let device: DeviceAuthorization = serde_json::from_value(device)
            .map_err(|_| "Qwen subscription: device/invalid_response".to_string())?;
        let lifetime = positive_duration(device.expires_in)
            .ok_or_else(|| "Qwen subscription: device/invalid_response".to_string())?;
        let mut interval = positive_duration(device.interval)
            .ok_or_else(|| "Qwen subscription: device/invalid_response".to_string())?;
        let deadline = issued_at
            .checked_add(lifetime)
            .ok_or_else(|| "Qwen subscription: device/invalid_response".to_string())?;
        if !valid_text(&device.device_code) || !valid_text(&device.user_code) {
            return Err("Qwen subscription: device/invalid_response".to_string());
        }
        if Instant::now() >= deadline {
            return Err("Qwen subscription: exchange/expired_token".to_string());
        }
        // Build the official tracked browser URL locally; never follow a server-supplied destination.
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("user_code", device.user_code.as_str()),
                ("client", "cli"),
                ("entry", "qwen_code"),
                ("paywallScene", "cli"),
            ])
            .finish();
        ui.on_auth(
            &format!("https://chat.qwen.ai/authorize?{query}"),
            Some(&format!("Enter code: {}", device.user_code)),
        );
        ui.on_progress("Waiting for Qwen subscription authorization...");
        let mut delay = interval;
        let polling = async {
            loop {
                check_cancelled(ui)?;
                let remaining = deadline.saturating_duration_since(Instant::now());
                tokio::time::sleep(delay.min(remaining)).await;
                check_cancelled(ui)?;
                if Instant::now() >= deadline {
                    return Err("Qwen subscription: exchange/expired_token".to_string());
                }
                let result = request_json(
                    http,
                    form_request(
                        TOKEN_URL,
                        &[
                            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                            ("client_id", CLIENT_ID),
                            ("device_code", device.device_code.as_str()),
                        ],
                    ),
                    REQUEST_TIMEOUT_MS,
                )
                .await;
                check_cancelled(ui)?;
                if Instant::now() >= deadline {
                    return Err("Qwen subscription: exchange/expired_token".to_string());
                }
                match result {
                    Ok(body) => return credentials_from(body, "exchange"),
                    Err(error) => {
                        if error.status == Some(400) && error.code == "authorization_pending" {
                            delay = interval;
                        } else if error.status == Some(400) && error.code == "slow_down" {
                            interval = interval.saturating_add(Duration::from_secs(5));
                            delay = interval;
                        } else if error.status == Some(429)
                            || error.status.is_some_and(|status| status >= 500)
                            || matches!(error.code, "request_failed" | "request_timeout")
                        {
                            delay = interval.max(delay.saturating_mul(2));
                        } else {
                            return Err(error.message("exchange"));
                        }
                    }
                }
            }
        };
        tokio::time::timeout_at(deadline, polling)
            .await
            .map_err(|_| "Qwen subscription: exchange/expired_token".to_string())?
    };
    tokio::select! {
        biased;
        () = cancelled => Err(LOGIN_CANCELLED.to_string()),
        result = login => result,
    }
}

/// Replace both tokens with the modern subscription refresh grant's rotating pair.
///
/// Membership is deliberately not checked here: the caller must durably save the new pair first.
///
/// # Errors
///
/// Returns a sanitized refresh error, without response bodies, server descriptions, or tokens.
#[tracing::instrument(skip_all)]
pub async fn refresh_qwen_subscription_token(
    http: &dyn ProviderHttp,
    refresh_token: &str,
) -> Result<QwenSubscriptionCredentials, String> {
    if !valid_text(refresh_token) {
        return Err("Qwen subscription: refresh/invalid_credentials".to_string());
    }
    let body = request_json(
        http,
        form_request(
            TOKEN_URL,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", CLIENT_ID),
                ("refresh_token", refresh_token),
            ],
        ),
        REFRESH_TIMEOUT_MS,
    )
    .await
    .map_err(|error| error.message("refresh"))?;
    credentials_from(body, "refresh")
}

/// Confirm whether modern `/userinfo` reports case-insensitive Plus or Pro membership.
///
/// `false` is a valid unpaid membership, not a failed identity query. Call this only after saving newly acquired credentials; an unavailable identity service must not discard a rotating pair.
///
/// # Errors
///
/// Returns a sanitized userinfo error for failed requests or malformed identity responses.
#[tracing::instrument(skip_all)]
pub async fn check_qwen_subscription_membership(
    http: &dyn ProviderHttp,
    access_token: &str,
) -> Result<bool, String> {
    if !valid_text(access_token) {
        return Err("Qwen subscription: userinfo/invalid_credentials".to_string());
    }
    let body = request_json(
        http,
        ProviderHttpRequest {
            method: ProviderHttpMethod::Get,
            url: USERINFO_URL.to_string(),
            headers: vec![
                ("Accept".to_string(), "application/json".to_string()),
                (
                    "Authorization".to_string(),
                    format!("Bearer {access_token}"),
                ),
                ("User-Agent".to_string(), qwen_subscription_user_agent()),
            ],
            body: None,
            follow_redirects: false,
        },
        REQUEST_TIMEOUT_MS,
    )
    .await
    .map_err(|error| error.message("userinfo"))?;
    let member_type = body.get("member_type").and_then(Value::as_str);
    if !body
        .get("sub")
        .and_then(Value::as_str)
        .is_some_and(valid_text)
        || !body.get("name").is_some_and(Value::is_string)
        || !body.get("email").is_some_and(Value::is_string)
        || !member_type.is_some_and(valid_text)
    {
        return Err("Qwen subscription: userinfo/invalid_response".to_string());
    }
    Ok(member_type
        .is_some_and(|tier| tier.eq_ignore_ascii_case("plus") || tier.eq_ignore_ascii_case("pro")))
}

/// Qwen's native-client identity, shared by subscription OAuth and inference requests.
pub(crate) fn qwen_subscription_user_agent() -> String {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "solaris" | "illumos" => "sunos",
        platform => platform,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc" => "ppc",
        "powerpc64" => "ppc64",
        "loongarch64" => "loong64",
        arch => arch,
    };
    // QwenCode is the service's native-client wire identifier, not product branding.
    format!("QwenCode/unknown ({platform}; {arch})")
}

fn form_request(url: &str, fields: &[(&str, &str)]) -> ProviderHttpRequest {
    ProviderHttpRequest {
        method: ProviderHttpMethod::Post,
        url: url.to_string(),
        headers: vec![
            ("Accept".to_string(), "application/json".to_string()),
            (
                "Content-Type".to_string(),
                "application/x-www-form-urlencoded".to_string(),
            ),
            ("User-Agent".to_string(), qwen_subscription_user_agent()),
        ],
        body: Some(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(fields.iter().copied())
                .finish(),
        ),
        follow_redirects: false,
    }
}

#[tracing::instrument(skip_all)]
async fn request_json(
    http: &dyn ProviderHttp,
    request: ProviderHttpRequest,
    timeout_ms: u64,
) -> Result<Value, RequestFailure> {
    let response = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        http.request(request, timeout_ms),
    )
    .await
    .map_err(|_| RequestFailure {
        code: "request_timeout",
        status: None,
    })?
    .map_err(|_| RequestFailure {
        code: "request_failed",
        status: None,
    })?;
    let parsed: Result<Value, _> = serde_json::from_str(&response.body);
    if !response.ok() {
        let received_code = parsed
            .as_ref()
            .ok()
            .and_then(|body| body.get("error"))
            .and_then(Value::as_str);
        let code = SAFE_OAUTH_ERRORS
            .iter()
            .copied()
            .find(|known| Some(*known) == received_code)
            .unwrap_or("http_error");
        return Err(RequestFailure {
            code,
            status: Some(response.status),
        });
    }
    parsed.map_err(|_| RequestFailure {
        code: "invalid_response",
        status: Some(response.status),
    })
}

fn credentials_from(body: Value, stage: &str) -> Result<QwenSubscriptionCredentials, String> {
    let invalid = || format!("Qwen subscription: {stage}/invalid_response");
    let token: TokenResponse = serde_json::from_value(body).map_err(|_| invalid())?;
    if !valid_text(&token.access_token)
        || !valid_text(&token.refresh_token)
        || token.token_type != "Bearer"
    {
        return Err(invalid());
    }
    let lifetime = positive_duration(token.expires_in).ok_or_else(invalid)?;
    let lifetime_ms = i64::try_from(lifetime.as_millis()).map_err(|_| invalid())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .ok_or_else(invalid)?;
    Ok(QwenSubscriptionCredentials {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: now
            .saturating_add(lifetime_ms)
            .saturating_sub(REFRESH_SKEW_MS.min(lifetime_ms / 2)),
    })
}

fn positive_duration(seconds: f64) -> Option<Duration> {
    Duration::try_from_secs_f64(seconds)
        .ok()
        .filter(|duration| !duration.is_zero())
}

fn check_cancelled(ui: &dyn OAuthLoginUi) -> Result<(), String> {
    if ui.is_cancelled() {
        Err(LOGIN_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains(['\r', '\n', '\0'])
}

#[cfg(test)]
mod tests;
