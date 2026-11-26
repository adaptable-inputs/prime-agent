use super::*;
use crate::oauth::{OAuthPrompt, ProviderHttpResponse};
use serde_json::json;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tokio::sync::Notify;

enum Step {
    Response(ProviderHttpResponse),
    Failure(String),
    Pending,
}

impl Step {
    fn json(status: u16, body: &Value) -> Self {
        Self::Response(ProviderHttpResponse {
            status,
            body: body.to_string(),
        })
    }
}

#[derive(Clone)]
struct RecordedRequest {
    request: ProviderHttpRequest,
    timeout_ms: u64,
    at: Instant,
}

struct ScriptedHttp {
    steps: Mutex<VecDeque<Step>>,
    requests: Mutex<Vec<RecordedRequest>>,
    called: Notify,
}

impl ScriptedHttp {
    fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: Mutex::new(steps.into()),
            requests: Mutex::new(Vec::new()),
            called: Notify::new(),
        }
    }

    fn captured(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl ProviderHttp for ScriptedHttp {
    fn request(
        &self,
        request: ProviderHttpRequest,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, String>> + Send + '_>> {
        self.requests.lock().unwrap().push(RecordedRequest {
            request,
            timeout_ms,
            at: Instant::now(),
        });
        self.called.notify_one();
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted request");
        Box::pin(async move {
            match step {
                Step::Response(response) => Ok(response),
                Step::Failure(message) => Err(message),
                Step::Pending => std::future::pending().await,
            }
        })
    }
}

#[derive(Default)]
struct ScriptedUi {
    auth: Mutex<Vec<(String, Option<String>)>>,
    progress: Mutex<Vec<String>>,
    cancelled: AtomicBool,
    cancel_on_auth: bool,
    presented: Notify,
}

impl OAuthLoginUi for ScriptedUi {
    fn on_auth(&self, url: &str, instructions: Option<&str>) {
        self.auth
            .lock()
            .unwrap()
            .push((url.to_string(), instructions.map(str::to_string)));
        self.presented.notify_one();
        if self.cancel_on_auth {
            self.cancelled.store(true, Ordering::Relaxed);
        }
    }

    fn on_prompt(
        &self,
        _prompt: &OAuthPrompt,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        panic!("a device grant never prompts for a copied token");
    }

    fn on_progress(&self, message: &str) {
        self.progress.lock().unwrap().push(message.to_string());
    }

    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
        None
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

fn device(interval: f64, expires_in: f64) -> Step {
    Step::json(
        200,
        &json!({
            "device_code": "device+&secret",
            "user_code": "ABCD-1234",
            "verification_uri": "https://chat.qwen.ai/authorize",
            "verification_uri_complete": "https://chat.qwen.ai/authorize?user_code=ABCD-1234",
            "interval": interval,
            "expires_in": expires_in,
        }),
    )
}

fn tokens() -> Value {
    json!({
        "access_token": "new-access",
        "refresh_token": "new-refresh",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": "model:invoke profile:read",
    })
}

fn expected_post(url: &str, body: &str) -> ProviderHttpRequest {
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
        body: Some(body.to_string()),
        follow_redirects: false,
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[tokio::test]
async fn device_grant_uses_modern_forms_and_leaves_membership_to_the_caller() {
    let http = ScriptedHttp::new(vec![
        device(0.002, 60.0),
        Step::json(400, &json!({"error": "authorization_pending"})),
        Step::json(200, &tokens()),
    ]);
    let ui = ScriptedUi::default();
    let before = now_ms();
    let credentials = login_qwen_subscription(&http, &ui).await.unwrap();
    assert_eq!(
        credentials,
        QwenSubscriptionCredentials {
            access: "new-access".to_string(),
            refresh: "new-refresh".to_string(),
            expires: credentials.expires,
        }
    );
    assert!((before + 3_570_000..=now_ms() + 3_570_000).contains(&credentials.expires));
    let recorded = http.captured();
    let requests: Vec<_> = recorded
        .iter()
        .map(|entry| (entry.request.clone(), entry.timeout_ms))
        .collect();
    let poll = expected_post(
        "https://auth.qwen.ai/api/oauth/token",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=qwen-code-cli&device_code=device%2B%26secret",
    );
    assert_eq!(
        requests,
        vec![
            (
                expected_post(
                    "https://auth.qwen.ai/api/oauth/device/code",
                    "client_id=qwen-code-cli&scope=model%3Ainvoke+profile%3Aread",
                ),
                30_000,
            ),
            (poll.clone(), 30_000),
            (poll, 30_000),
        ]
    );
    assert_eq!(
        *ui.auth.lock().unwrap(),
        vec![(
            "https://chat.qwen.ai/authorize?user_code=ABCD-1234&client=cli&entry=qwen_code&paywallScene=cli".to_string(),
            Some("Enter code: ABCD-1234".to_string()),
        )]
    );
    for pair in recorded.windows(2) {
        assert!(pair[1].at.duration_since(pair[0].at) >= Duration::from_millis(2));
    }
}

#[tokio::test]
async fn slow_down_adds_five_seconds_to_the_advertised_poll_interval() {
    let http = ScriptedHttp::new(vec![
        device(0.001, 20.0),
        Step::json(400, &json!({"error": "slow_down"})),
        Step::json(200, &tokens()),
    ]);
    login_qwen_subscription(&http, &ScriptedUi::default())
        .await
        .unwrap();
    let recorded = http.captured();
    assert_eq!(recorded.len(), 3);
    assert!(recorded[2].at.duration_since(recorded[1].at) >= Duration::from_millis(5001));
}

#[tokio::test]
async fn transient_poll_failures_back_off_and_pending_restores_the_server_interval() {
    let http = ScriptedHttp::new(vec![
        device(0.006, 10.0),
        Step::Failure("network details containing device+&secret".to_string()),
        Step::json(503, &json!({"error": "secret-server-message"})),
        Step::json(429, &json!({"error": "rate_limited"})),
        Step::json(400, &json!({"error": "authorization_pending"})),
        Step::json(200, &tokens()),
    ]);
    login_qwen_subscription(&http, &ScriptedUi::default())
        .await
        .unwrap();
    let recorded = http.captured();
    assert_eq!(recorded.len(), 6);
    for (pair, minimum_ms) in recorded.windows(2).zip([6, 12, 24, 48, 6]) {
        assert!(
            pair[1].at.duration_since(pair[0].at) >= Duration::from_millis(minimum_ms),
            "poll interval must be at least {minimum_ms}ms",
        );
    }
}

#[tokio::test]
async fn grant_expiry_bounds_hanging_requests_and_prevents_a_late_poll() {
    for (interval, lifetime, expected_count) in [(0.001, 1.0, 2), (1.0, 0.01, 1)] {
        let http = ScriptedHttp::new(vec![device(interval, lifetime), Step::Pending]);
        let error = login_qwen_subscription(&http, &ScriptedUi::default())
            .await
            .unwrap_err();
        assert_eq!(error, "Qwen subscription: exchange/expired_token");
        assert_eq!(http.captured().len(), expected_count);
    }
}

#[tokio::test]
async fn cancellation_interrupts_an_in_flight_request_and_a_poll_wait() {
    let http = ScriptedHttp::new(vec![Step::Pending]);
    let ui = ScriptedUi::default();
    let login = login_qwen_subscription(&http, &ui);
    tokio::pin!(login);
    tokio::select! {
        result = &mut login => panic!("request should be pending: {result:?}"),
        () = http.called.notified() => {},
    }
    ui.cancelled.store(true, Ordering::Relaxed);
    assert_eq!(login.await.unwrap_err(), LOGIN_CANCELLED);
    assert_eq!(http.captured().len(), 1);

    let http = ScriptedHttp::new(vec![device(60.0, 120.0)]);
    let ui = ScriptedUi::default();
    let login = login_qwen_subscription(&http, &ui);
    tokio::pin!(login);
    tokio::select! {
        result = &mut login => panic!("poll should be waiting: {result:?}"),
        () = ui.presented.notified() => {},
    }
    ui.cancelled.store(true, Ordering::Relaxed);
    assert_eq!(login.await.unwrap_err(), LOGIN_CANCELLED);
    assert_eq!(http.captured().len(), 1);

    let http = ScriptedHttp::new(Vec::new());
    let ui = ScriptedUi::default();
    ui.cancelled.store(true, Ordering::Relaxed);
    assert_eq!(
        login_qwen_subscription(&http, &ui).await.unwrap_err(),
        LOGIN_CANCELLED
    );
    assert!(http.captured().is_empty());

    let http = ScriptedHttp::new(vec![device(0.001, 60.0)]);
    let ui = ScriptedUi {
        cancel_on_auth: true,
        ..ScriptedUi::default()
    };
    assert_eq!(
        login_qwen_subscription(&http, &ui).await.unwrap_err(),
        LOGIN_CANCELLED
    );
    assert_eq!(http.captured().len(), 1);
}

#[tokio::test]
async fn refresh_replaces_the_pair_without_querying_membership() {
    let http = ScriptedHttp::new(vec![Step::json(200, &tokens())]);
    let before = now_ms();
    let credentials = refresh_qwen_subscription_token(&http, "old+&refresh")
        .await
        .unwrap();
    assert_eq!(
        credentials,
        QwenSubscriptionCredentials {
            access: "new-access".to_string(),
            refresh: "new-refresh".to_string(),
            expires: credentials.expires,
        }
    );
    assert!((before + 3_570_000..=now_ms() + 3_570_000).contains(&credentials.expires));
    assert_eq!(
        http.captured()
            .into_iter()
            .map(|entry| (entry.request, entry.timeout_ms))
            .collect::<Vec<_>>(),
        vec![(
            expected_post(
                "https://auth.qwen.ai/api/oauth/token",
                "grant_type=refresh_token&client_id=qwen-code-cli&refresh_token=old%2B%26refresh",
            ),
            8_000,
        )]
    );
}

#[tokio::test]
async fn membership_requires_modern_identity_and_case_insensitive_plus_or_pro() {
    for (tier, expected) in [
        ("Plus", true),
        ("pRo", true),
        ("Free", false),
        ("Lite", false),
        ("Trial", false),
    ] {
        let http = ScriptedHttp::new(vec![Step::json(
            200,
            &json!({"sub": "user", "name": "", "email": "", "member_type": tier}),
        )]);
        assert_eq!(
            check_qwen_subscription_membership(&http, "access").await,
            Ok(expected)
        );
        assert_eq!(
            http.captured()
                .into_iter()
                .map(|entry| (entry.request, entry.timeout_ms))
                .collect::<Vec<_>>(),
            vec![(
                ProviderHttpRequest {
                    method: ProviderHttpMethod::Get,
                    url: "https://auth.qwen.ai/api/oauth/userinfo".to_string(),
                    headers: vec![
                        ("Accept".to_string(), "application/json".to_string()),
                        ("Authorization".to_string(), "Bearer access".to_string()),
                        ("User-Agent".to_string(), qwen_subscription_user_agent()),
                    ],
                    body: None,
                    follow_redirects: false,
                },
                30_000,
            )]
        );
    }
    let http = ScriptedHttp::new(vec![Step::json(200, &json!({"member_type": "Pro"}))]);
    assert_eq!(
        check_qwen_subscription_membership(&http, "access").await,
        Err("Qwen subscription: userinfo/invalid_response".to_string()),
    );
}

#[tokio::test]
async fn errors_never_echo_response_bodies_descriptions_or_transport_details() {
    let device_http = ScriptedHttp::new(vec![Step::json(
        400,
        &json!({"error": "access-token-secret", "error_description": "refresh-secret"}),
    )]);
    let exchange_http = ScriptedHttp::new(vec![
        device(0.001, 60.0),
        Step::json(
            403,
            &json!({"error": "access_denied", "error_description": "device+&secret"}),
        ),
    ]);
    let refresh_http = ScriptedHttp::new(vec![Step::Failure("refresh-secret".to_string())]);
    let userinfo_http = ScriptedHttp::new(vec![Step::Response(ProviderHttpResponse {
        status: 503,
        body: "<html>access-token-secret</html>".to_string(),
    })]);
    assert_eq!(
        vec![
            login_qwen_subscription(&device_http, &ScriptedUi::default())
                .await
                .unwrap_err(),
            login_qwen_subscription(&exchange_http, &ScriptedUi::default())
                .await
                .unwrap_err(),
            refresh_qwen_subscription_token(&refresh_http, "refresh-secret")
                .await
                .unwrap_err(),
            check_qwen_subscription_membership(&userinfo_http, "access-token-secret")
                .await
                .unwrap_err(),
        ],
        vec![
            "Qwen subscription: device/http_error (HTTP 400)",
            "Qwen subscription: exchange/access_denied (HTTP 403)",
            "Qwen subscription: refresh/request_failed",
            "Qwen subscription: userinfo/http_error (HTTP 503)",
        ],
    );
}

#[tokio::test]
async fn incomplete_or_unsafe_rotating_pairs_are_rejected() {
    let mut missing_refresh = tokens();
    missing_refresh
        .as_object_mut()
        .unwrap()
        .remove("refresh_token");
    let mut unsafe_access = tokens();
    unsafe_access["access_token"] = json!("access-secret\nheader");
    let mut invalid_lifetime = tokens();
    invalid_lifetime["expires_in"] = json!(0);
    for body in [missing_refresh, unsafe_access, invalid_lifetime] {
        let http = ScriptedHttp::new(vec![Step::json(200, &body)]);
        assert_eq!(
            refresh_qwen_subscription_token(&http, "old-refresh").await,
            Err("Qwen subscription: refresh/invalid_response".to_string()),
        );
    }
}
