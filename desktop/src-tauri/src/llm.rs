// A language model for the live sermon summary. One setting covers any
// service that speaks the OpenAI chat-completions protocol (OpenAI, z.ai,
// Kimi, OpenRouter, and local servers such as Ollama or LM Studio) or the
// Anthropic messages protocol (Claude, and z.ai's Anthropic endpoint).
//
// The settings live in the app data folder (llm.json, owner-only on Unix).
// The API key never goes back to the console; it only learns whether one is
// saved.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
struct Saved {
    #[serde(default)]
    enabled: bool,
    /// "openai" or "anthropic".
    #[serde(default)]
    protocol: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    api_key: String,
}

/// What the console sees.
#[derive(Serialize)]
pub struct LlmSettings {
    enabled: bool,
    protocol: String,
    base_url: String,
    model: String,
    has_key: bool,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("llm.json"))
}

fn load(app: &AppHandle) -> Saved {
    path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn llm_settings(app: AppHandle) -> LlmSettings {
    let s = load(&app);
    LlmSettings { enabled: s.enabled, protocol: s.protocol, base_url: s.base_url, model: s.model, has_key: !s.api_key.is_empty() }
}

/// Save the settings. `api_key` None keeps the saved key; "" clears it.
#[tauri::command]
pub fn set_llm_settings(
    app: AppHandle,
    enabled: bool,
    protocol: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    if protocol != "openai" && protocol != "anthropic" {
        return Err("Choose OpenAI-compatible or Anthropic-compatible.".into());
    }
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if enabled && !(base_url.starts_with("https://") || is_local_http(&base_url)) {
        return Err("The address must start with https:// (or http://localhost for a server on this computer).".into());
    }
    let mut s = load(&app);
    // A saved key belongs to its service: never send it to a new one.
    if host(&s.base_url) != host(&base_url) {
        s.api_key.clear();
    }
    s.enabled = enabled;
    s.protocol = protocol;
    s.base_url = base_url;
    s.model = model.trim().to_string();
    if let Some(k) = api_key {
        s.api_key = k.trim().to_string();
    }
    let p = path(&app)?;
    let text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        o.mode(0o600);
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    use std::io::Write;
    o.open(&p).and_then(|mut f| f.write_all(text.as_bytes())).map_err(|e| e.to_string())
}

/// "api.z.ai" from "https://api.z.ai/api/paas/v4".
fn host(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or("");
    rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase()
}

/// Plain http only for a server on this computer.
fn is_local_http(url: &str) -> bool {
    url.starts_with("http://") && {
        let h = host(url);
        let name = if h.starts_with('[') { h.split(']').next().unwrap_or("").to_string() + "]" } else { h.split(':').next().unwrap_or("").to_string() };
        matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]")
    }
}

/// The request for one completion: URL, headers and JSON body.
/// `json` asks for a JSON-only reply where the service is known to support it.
fn request(s: &Saved, system: &str, user: &str, max_tokens: u32, json: bool) -> (String, Vec<(&'static str, String)>, Value) {
    let mut headers = vec![("Content-Type", "application/json".to_string())];
    if s.protocol == "anthropic" {
        // "https://api.anthropic.com" and ".../v1" both work.
        let base = s.base_url.trim_end_matches("/v1");
        if !s.api_key.is_empty() {
            headers.push(("x-api-key", s.api_key.clone()));
        }
        headers.push(("anthropic-version", "2023-06-01".to_string()));
        let body = json!({
            "model": s.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        });
        (format!("{}/v1/messages", base), headers, body)
    } else {
        // A local server (Ollama, LM Studio) needs no key.
        if !s.api_key.is_empty() {
            headers.push(("Authorization", format!("Bearer {}", s.api_key)));
        }
        // No temperature: some models (kimi-k3) reject anything but their default.
        // OpenAI itself only takes the newer name for the limit.
        let limit = if s.base_url.contains("api.openai.com") { "max_completion_tokens" } else { "max_tokens" };
        let mut body = json!({
            "model": s.model,
            limit: max_tokens,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        // GLM thinks at length first and can spend the whole answer on it,
        // replying with nothing; glm-5.3 refuses thinking "disabled" but takes
        // a low effort. Other servers may reject the field.
        if is_zai(&s.base_url) {
            body["reasoning_effort"] = json!("low");
        }
        // LM Studio and some others refuse json_object; parsing copes without it.
        if json && (is_zai(&s.base_url) || s.base_url.contains("api.openai.com") || s.base_url.contains(":11434")) {
            body["response_format"] = json!({ "type": "json_object" });
        }
        (format!("{}/chat/completions", s.base_url), headers, body)
    }
}

fn is_zai(base_url: &str) -> bool {
    base_url.contains("api.z.ai") || base_url.contains("bigmodel.cn")
}

/// The reply text from either protocol's response.
fn reply_text(protocol: &str, v: &Value) -> Result<String, String> {
    let text = if protocol == "anthropic" {
        v["content"]
            .as_array()
            .map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""))
            .unwrap_or_default()
    } else {
        v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string()
    };
    if text.trim().is_empty() {
        return Err("The model sent an empty reply (it may have spent its whole answer thinking).".into());
    }
    Ok(text)
}

fn complete(s: &Saved, system: &str, user: &str, max_tokens: u32, json: bool) -> Result<String, String> {
    let (url, headers, body) = request(s, system, user, max_tokens, json);
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(120)).build();
    let mut req = agent.post(&url);
    for (k, v) in &headers {
        req = req.set(k, v);
    }
    let resp = match req.send_string(&body.to_string()) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&detail)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().or(v["message"].as_str()).map(str::to_string))
                .unwrap_or_else(|| detail.chars().take(200).collect());
            return Err(match code {
                401 | 403 => format!("The service rejected the API key ({}): {}", code, msg),
                404 => format!("Not found ({}): check the address and the model name. {}", code, msg),
                _ => format!("The service answered {}: {}", code, msg),
            });
        }
        Err(e) => return Err(format!("Could not reach {}: {}", s.base_url, e)),
    };
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "The service did not answer with JSON.".to_string())?;
    reply_text(&s.protocol, &v)
}

/// One completion with the saved settings.
#[tauri::command]
pub async fn llm_complete(app: AppHandle, system: String, user: String, max_tokens: Option<u32>, json: Option<bool>) -> Result<String, String> {
    let s = load(&app);
    if !s.enabled {
        return Err("AI summary is off. Turn it on in Settings.".into());
    }
    if s.model.is_empty() || s.base_url.is_empty() {
        return Err("Set the AI address and model in Settings.".into());
    }
    let max = max_tokens.unwrap_or(4000);
    let json = json.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        // One retry for a dropped request or an empty reply, not for a wrong key or address.
        complete(&s, &system, &user, max, json).or_else(|e| {
            if e.starts_with("The service rejected") || e.starts_with("Not found") {
                return Err(e);
            }
            std::thread::sleep(Duration::from_secs(2));
            complete(&s, &system, &user, max, json)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write the AI summary or the verse list into a session folder.
#[tauri::command]
pub fn save_session_file(app: AppHandle, dir: String, name: String, content: String) -> Result<(), String> {
    if name != "summary.md" && name != "verses.md" {
        return Err("not a session file".into());
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions");
    let d = crate::session::session_child(&root, std::path::Path::new(&dir)).ok_or("not a session folder")?;
    std::fs::write(d.join(name), content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(protocol: &str, base: &str, key: &str) -> Saved {
        Saved { enabled: true, protocol: protocol.into(), base_url: base.into(), model: "m".into(), api_key: key.into() }
    }

    #[test]
    fn openai_request_shape() {
        let (url, headers, body) = request(&saved("openai", "https://api.z.ai/api/coding/paas/v4", "k"), "sys", "hi", 100, true);
        assert_eq!(url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
        assert!(headers.contains(&("Authorization", "Bearer k".to_string())));
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(body.get("temperature").is_none());
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["response_format"]["type"], "json_object");
        let (_, _, body) = request(&saved("openai", "https://api.openai.com/v1", "k"), "s", "u", 10, true);
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn openai_itself_gets_the_new_limit_name() {
        let (_, _, body) = request(&saved("openai", "https://api.openai.com/v1", "k"), "s", "u", 10, true);
        assert_eq!(body["max_completion_tokens"], 10);
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn plain_http_only_on_this_computer() {
        assert!(is_local_http("http://localhost:11434/v1"));
        assert!(is_local_http("http://127.0.0.1:1234/v1"));
        assert!(is_local_http("http://[::1]:1234/v1"));
        assert!(!is_local_http("http://example.com/v1"));
        assert!(!is_local_http("http://localhost.example.com/v1"));
        assert_eq!(host("https://API.z.ai/api/paas/v4"), "api.z.ai");
    }

    #[test]
    fn local_server_sends_no_key() {
        let (_, headers, _) = request(&saved("openai", "http://localhost:11434/v1", ""), "s", "u", 10, true);
        assert!(!headers.iter().any(|(k, _)| *k == "Authorization"));
    }

    #[test]
    fn anthropic_request_shape() {
        for base in ["https://api.anthropic.com", "https://api.anthropic.com/v1"] {
            let (url, headers, body) = request(&saved("anthropic", base, "k"), "sys", "hi", 100, true);
            assert_eq!(url, "https://api.anthropic.com/v1/messages");
            assert!(headers.contains(&("x-api-key", "k".to_string())));
            assert_eq!(body["system"], "sys");
            assert_eq!(body["messages"][0]["content"], "hi");
        }
    }

    /// Live: LLM_PROTOCOL, LLM_BASE, LLM_MODEL, LLM_KEY;
    /// cargo test --lib llm::tests::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live() {
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let s = Saved { enabled: true, protocol: env("LLM_PROTOCOL"), base_url: env("LLM_BASE"), model: env("LLM_MODEL"), api_key: env("LLM_KEY") };
        let reply = complete(&s, "Reply in JSON.", "Give {\"ok\": true} and nothing else.", 400, true).unwrap();
        println!("reply: {reply}");
        assert!(reply.contains("ok"));
    }

    #[test]
    fn reply_text_both_protocols() {
        let a = json!({ "content": [{ "type": "text", "text": "{\"a\":" }, { "type": "text", "text": "1}" }] });
        assert_eq!(reply_text("anthropic", &a).unwrap(), "{\"a\":1}");
        let o = json!({ "choices": [{ "message": { "content": "ok" } }] });
        assert_eq!(reply_text("openai", &o).unwrap(), "ok");
        let empty = json!({ "choices": [{ "message": { "content": "", "reasoning_content": "hmm" } }] });
        assert!(reply_text("openai", &empty).is_err());
    }
}
