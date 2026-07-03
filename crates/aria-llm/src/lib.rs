//! LLM gateway client (spec §6.4): OpenAI-compatible SSE streaming over a
//! keep-alive connection. Endpoint/key come from config, never hardcoded (A-9).

use std::io::{BufRead, BufReader};

use aria_core::{ChatMsg, Llm, StageError};
use serde_json::{json, Value};

/// A-13: prompt for the DIRECT (tool-less) LLM — anti-confabulation so tool
/// syntax can't leak into spoken replies.
pub const DIRECT_SYSTEM_PROMPT: &str = "You are ARIA, a helpful voice assistant. \
Reply conversationally and concisely — your words are spoken aloud. \
Never output code blocks, markdown, tool calls, or function syntax; \
if asked for code, describe it in plain speech instead. \
You have no tools in this mode; if a request needs live data or actions, \
say plainly that you'll need the agent for that.";

/// Prompt for the AGENT HARNESS — must NOT discourage tool use (v2's shared
/// prompt caused 'ask Alexa' answers; the harness has real tools — let it
/// use them).
pub const HARNESS_SYSTEM_PROMPT: &str = "You are ARIA, a voice assistant with \
full agent capabilities. Use your tools and skills whenever they help — \
weather, web, files, screen, anything actionable: do it, don't tell the user \
to do it themselves or to use another device. Keep spoken replies short, \
conversational, plain text — no markdown, no code blocks, no URLs unless asked.";

pub struct GatewayLlm {
    agent: ureq::Agent,
    endpoint: String,
    api_key: String,
    model: String,
    system_prompt: String,
    pending_image: Option<String>,
}

impl GatewayLlm {
    pub fn new(endpoint: &str, api_key: &str, model: &str) -> Self {
        // ureq keeps connections alive by default (A-8); TCP_NODELAY is on
        // by default in ureq 3's transport.
        Self {
            agent: ureq::Agent::new_with_defaults(),
            endpoint: endpoint.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
            system_prompt: HARNESS_SYSTEM_PROMPT.to_string(),
            pending_image: None,
        }
    }

    pub fn with_system_prompt(mut self, prompt: &str) -> Self {
        self.system_prompt = prompt.to_string();
        self
    }
}

impl Llm for GatewayLlm {
    fn complete(
        &mut self,
        history: &[ChatMsg],
        on_sentence: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), StageError> {
        // Full session context every turn; cap so the request stays bounded.
        const MAX_TURNS: usize = 24;
        let start = history.len().saturating_sub(MAX_TURNS);
        let image = self.pending_image.take();
        let mut messages = vec![json!({"role": "system", "content": self.system_prompt})];
        let last = history.len() - 1;
        for (i, m) in history.iter().enumerate().skip(start) {
            // Screen-share frame rides on the current user message (A-19).
            if i == last && m.role == "user" && image.is_some() {
                messages.push(json!({"role": "user", "content": [
                    {"type": "text", "text": m.content},
                    {"type": "image_url", "image_url": {"url": image.as_ref().unwrap()}},
                ]}));
            } else {
                messages.push(json!({"role": m.role, "content": m.content}));
            }
        }
        let body = json!({
            "model": self.model,
            "stream": true,
            "messages": messages,
        });
        let mut req = self
            .agent
            .post(format!("{}/v1/chat/completions", self.endpoint));
        if !self.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.api_key));
        }
        let resp = req
            .send_json(&body)
            .map_err(|e| StageError::Engine(format!("llm request: {e}")))?;

        let reader = BufReader::new(resp.into_body().into_reader());
        let mut pending = String::new();
        for line in reader.lines() {
            let line = line.map_err(|e| StageError::Engine(format!("llm stream: {e}")))?;
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                break;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue; // tolerate malformed keepalive/comment lines
            };
            if let Some(tok) = v["choices"][0]["delta"]["content"].as_str() {
                pending.push_str(tok);
                // Eager sentence emission so TTS starts immediately (A-8).
                while let Some(end) = sentence_end(&pending) {
                    let sentence: String = pending.drain(..end).collect();
                    let sentence = sentence.trim();
                    if !sentence.is_empty() && !on_sentence(sentence) {
                        return Ok(()); // aborted (barge-in) — drop the stream
                    }
                }
            }
        }
        let rest = pending.trim();
        if !rest.is_empty() {
            on_sentence(rest);
        }
        Ok(())
    }

    fn set_image(&mut self, data_url: Option<String>) {
        self.pending_image = data_url;
    }
}

/// Index just past the first sentence terminator that is followed by
/// whitespace/end — avoids splitting "3.14" or "e.g.".
fn sentence_end(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let substantial = || s[..=i].trim().len() > 2; // "e.g." guard
        if b == b'\n' {
            if substantial() {
                return Some(i + 1);
            }
            continue;
        }
        if matches!(b, b'.' | b'!' | b'?') {
            let next = bytes.get(i + 1);
            let prev_digit = i > 0 && bytes[i - 1].is_ascii_digit();
            // Split only when followed by whitespace (not "3.14") and more
            // text exists; a trailing fragment is flushed by the caller.
            if next.is_some_and(|n| n.is_ascii_whitespace())
                && !(b == b'.' && prev_digit)
                && substantial()
            {
                return Some(i + 1);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// One-shot fake OpenAI SSE gateway on a random port.
    fn fake_gateway(tokens: &[&str]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let events: Vec<String> = tokens
            .iter()
            .map(|t| {
                format!(
                    "data: {}\n\n",
                    json!({"choices":[{"delta":{"content": t}}]})
                )
            })
            .chain(["data: [DONE]\n\n".to_string()])
            .collect();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut buf); // consume request
            let body: String = events.concat();
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(resp.as_bytes()).unwrap();
        });
        format!("http://{addr}")
    }

    fn user(text: &str) -> Vec<ChatMsg> {
        vec![ChatMsg::now("user", text)]
    }

    #[test]
    fn streams_and_chunks_sentences() {
        let url = fake_gateway(&["Hel", "lo there. ", "It is ", "2.5 degrees. ", "Bye"]);
        let mut llm = GatewayLlm::new(&url, "test-key", "hermes");
        let mut got = Vec::new();
        llm.complete(&user("hi"), &mut |s| { got.push(s.to_string()); true }).unwrap();
        assert_eq!(got, vec!["Hello there.", "It is 2.5 degrees.", "Bye"]);
    }

    #[test]
    fn gateway_down_is_an_engine_error() {
        let mut llm = GatewayLlm::new("http://127.0.0.1:9", "", "hermes");
        assert!(llm.complete(&user("hi"), &mut |_| true).is_err());
    }

    #[test]
    fn sentence_end_edges() {
        assert_eq!(sentence_end("Hello. World"), Some(6));
        assert_eq!(sentence_end("3.14 is pi"), None);
        assert_eq!(sentence_end("no terminator"), None);
        assert_eq!(sentence_end("Line one\nrest"), Some(9));
    }
}
