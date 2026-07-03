//! Mixture-mode router: per-query choice between the agent harness (tools)
//! and an optional direct LLM (fast tool-less chat). Both share one session
//! history, and a harness follow-up question makes the next reply sticky so
//! handoffs complete ("where are you?" → "Miami" must go back to the harness).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Harness,
    Direct,
}

/// Queries that need live data, actions, or device access — never answerable
/// from a tool-less model without hallucinating (the v2 failure mode).
const TOOL_INTENTS: &[&str] = &[
    // live data
    "weather", "temperature", "forecast", "news", "stock", "price of", "score",
    "today", "tonight", "tomorrow", "right now", "currently", "latest", "current",
    "what time", "date today",
    // web
    "search", "look up", "google", "browse", "website", "link me", "find me",
    // actions & device
    "open ", "run ", "execute", "install", "download", "launch", "play ",
    "file", "folder", "directory", "screenshot", "screen share", "my screen",
    "clipboard", "remind", "timer", "alarm", "schedule", "calendar", "email",
    "send ", "message ", "call ",
    // personal/contextual data a bare LLM can't know
    "my location", "near me", "where am i",
];

pub struct Router {
    /// "auto" | "direct" | "harness"
    mode: String,
    has_direct: bool,
    /// Set when the harness's last reply asked the user something — the
    /// user's next message returns to the harness even if it looks simple.
    sticky_harness: bool,
}

impl Router {
    pub fn new(mode: &str, has_direct: bool) -> Self {
        Self { mode: mode.to_string(), has_direct, sticky_harness: false }
    }

    pub fn route(&self, text: &str) -> Route {
        if !self.has_direct || self.mode == "harness" {
            return Route::Harness;
        }
        if self.mode == "direct" {
            return Route::Direct;
        }
        // auto
        if self.sticky_harness {
            return Route::Harness;
        }
        let t = text.to_lowercase();
        if TOOL_INTENTS.iter().any(|k| t.contains(k)) {
            Route::Harness
        } else {
            Route::Direct
        }
    }

    /// Feed back each assistant reply so handoff continuations stick.
    pub fn observe_reply(&mut self, route: Route, reply: &str) {
        self.sticky_harness = route == Route::Harness && reply.trim_end().ends_with('?');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_direct_configured_means_harness_always() {
        let r = Router::new("auto", false);
        assert_eq!(r.route("hello there"), Route::Harness);
    }

    #[test]
    fn auto_routes_tool_intents_to_harness() {
        let r = Router::new("auto", true);
        for q in [
            "what's the weather for my location",
            "search for rust audio crates",
            "open the downloads folder",
            "remind me at 6pm",
            "what's the latest news",
        ] {
            assert_eq!(r.route(q), Route::Harness, "{q}");
        }
        for q in ["hello how are you", "tell me a joke", "explain quicksort simply"] {
            assert_eq!(r.route(q), Route::Direct, "{q}");
        }
    }

    #[test]
    fn harness_question_makes_next_turn_sticky() {
        let mut r = Router::new("auto", true);
        assert_eq!(r.route("what's the weather"), Route::Harness);
        r.observe_reply(Route::Harness, "Sure — where are you located?");
        // A bare location looks "simple" but must return to the harness.
        assert_eq!(r.route("Miami, Florida"), Route::Harness);
        r.observe_reply(Route::Harness, "It's 91 degrees and sunny in Miami.");
        assert_eq!(r.route("thanks! tell me a joke"), Route::Direct);
    }

    #[test]
    fn forced_modes_override_intent() {
        let r = Router::new("direct", true);
        assert_eq!(r.route("what's the weather"), Route::Direct);
        let r = Router::new("harness", true);
        assert_eq!(r.route("tell me a joke"), Route::Harness);
    }
}
