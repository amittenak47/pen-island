//! What the reader says they are reading, and the shape of the notes they want.
//!
//! Chosen on every ChatBot request (a single footnote or a page run) and
//! carried with it, so the same book can be read as a story one day and studied
//! the next. An assistant gets it as a `guide`: plain instructions built here
//! from the kind of text and the note fields, so the advice for a novel never
//! reads like the advice for a textbook. Notes come back free-form, or as
//! labelled fields from the reader's preset, which are checked for substance
//! and folded into ordinary notes.

use serde::{Deserialize, Serialize};

/// Kinds of text a reader can say they are reading.
pub const KINDS: &[&str] = &["textbook", "story", "article", "paper", "notes", "code", "other"];
/// Most fields one preset can hold.
pub const MAX_FIELDS: usize = 8;
/// Fewest words a field may have: shorter is a heading, not a note.
const MIN_FIELD_WORDS: usize = 6;
/// The field naming attached tasks. A short list is its whole point, and
/// with nothing attached to name it is left out even when every field is asked for.
pub const HELPS_WITH: &str = "Helps with";

/// What the fields any kind of text can use mean, told to the assistant
/// when a preset includes them.
const SHARED_FIELDS: &[(&str, &str)] = &[
    (HELPS_WITH, "Helps with names the attached tasks this passage prepares the reader for (exercises, \
        homework, essay prompts, discussion questions) by their numbers or titles in the attachments, \
        never their answers; leave it out when nothing attached is a task."),
    ("Think about it", "Think about it asks one short question that makes the reader curious to keep \
        reading, without giving its answer away."),
    ("Looking ahead", "Looking ahead hints at what the passage sets up, drawn only from the pages you were \
        given; never reveal later events."),
];

fn is_helps_with(label: &str) -> bool {
    label.trim().eq_ignore_ascii_case(HELPS_WITH)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ReadingStyle {
    /// One of [`KINDS`]; empty on requests made before reading styles.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// The preset's field labels, in order. Empty means free-form notes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
    /// "best" (only the fields that fit) or "all" (every field). Fields only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fill: String,
    /// The preset's name, for the reader's history; not used to answer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub preset: String,
}

/// One labelled part of a footnote, as an assistant fills a preset.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct NoteField {
    pub label: String,
    pub text: String,
}

fn squeezed(text: &str) -> String {
    text.chars().filter(|ch| ch.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

impl ReadingStyle {
    /// Nothing chosen: a request from before reading styles.
    pub fn is_empty(&self) -> bool {
        self.kind.is_empty() && self.fields.is_empty()
    }

    /// The labels of `fields` that this style's preset uses, in its order.
    pub fn used_labels(&self, fields: &[NoteField]) -> Vec<String> {
        self.fields.iter()
            .filter(|label| fields.iter().any(|field| field.label.trim().eq_ignore_ascii_case(label.trim())))
            .map(|label| label.trim().to_string())
            .collect()
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.kind.is_empty() && !KINDS.contains(&self.kind.as_str()) {
            return Err(format!("reading.kind must be one of {}", KINDS.join(", ")));
        }
        if self.fields.len() > MAX_FIELDS {
            return Err(format!("reading.fields may hold at most {MAX_FIELDS} labels"));
        }
        let mut seen = Vec::new();
        for label in &self.fields {
            let label = label.trim();
            if label.is_empty() || label.chars().count() > 40 {
                return Err("each reading field label needs 1..=40 characters".into());
            }
            let key = label.to_lowercase();
            if seen.contains(&key) {
                return Err(format!("reading.fields lists \"{label}\" twice"));
            }
            seen.push(key);
        }
        match (self.fields.is_empty(), self.fill.as_str()) {
            (true, "") => {}
            (true, _) => return Err("reading.fill applies only with fields".into()),
            (false, "best" | "all") => {}
            (false, _) => return Err("reading.fill must be best or all".into()),
        }
        if self.preset.chars().count() > 60 {
            return Err("reading.preset must be at most 60 characters".into());
        }
        Ok(())
    }

    /// How an assistant should write for this request, in plain words.
    pub fn guide(&self) -> String {
        let kind = match self.kind.as_str() {
            "textbook" => "The reader is studying a textbook. Explain what a student needs from the passage: \
                what a definition really says, the steps of a method and why they work, the idea behind a proof, \
                and the mistakes people usually make. When problems are attached, show where a problem will lean \
                on the passage, as a hint or a preview; never solve a problem or quote a solution.",
            "story" => "The reader is reading a story. Write as a perceptive reading companion: context the \
                reader may lack, what a line or a choice reveals about a character, the meaning or effect of an \
                unusual word or phrase, and themes as they take shape. Never mention anything that happens after \
                the pages you were given, even if you know the book: hints and questions come only from what is \
                already on the page.",
            "article" => "The reader is reading an article or essay. Follow the argument: the claim being made, \
                the evidence offered for it, what it takes for granted, where a careful reader might push back, \
                and the terms it depends on.",
            "paper" => "The reader is reading a research paper. Make clear the paper's contribution, the method \
                and why it is built that way, its assumptions and limitations, and the notation or background a \
                reader may lack. Relate it to other work only when you are sure of the connection.",
            "notes" => "The reader is reading their own notes or homework. Clarify the idea behind each step, \
                check the reasoning, and point out a step that looks wrong or unjustified without rewriting the \
                work for them.",
            "code" => "The reader is reading source code. Explain what a passage does, why it is written that \
                way, and the pitfall it guards against or leaves open.",
            _ => "Explain what a thoughtful reader would want to understand about the passage.",
        };
        let shape = if self.fields.is_empty() {
            "Write free-form markdown notes of a few sentences each, each opening with a short bold label of \
             two to four words and a colon that names its specific idea (for example **A cold first meeting:**, \
             never a generic heading like **Why it matters:**). When something attached is a task (an \
             exercise, homework, an essay prompt, a discussion question) this passage prepares for, a note \
             labelled **Helps with:** may name it by its number or title, never its answer."
                .to_string()
        } else {
            let labels = self.fields.join(", ");
            let fill = if self.fill == "all" {
                "Fill every one of these fields for each footnote, a sentence or two each, without padding \
                 (Helps with only when something attached is a task)."
            } else {
                "Use only the fields that have something specific and worthwhile to say about this passage, \
                 usually two or three; leave the others out."
            };
            let meanings: Vec<&str> = SHARED_FIELDS.iter()
                .filter(|(label, _)| self.fields.iter().any(|field| field.trim().eq_ignore_ascii_case(label)))
                .map(|(_, meaning)| *meaning)
                .collect();
            let meanings = if meanings.is_empty() { String::new() } else { format!(" {}", meanings.join(" ")) };
            format!("Write each footnote's body as `fields`, each with one of these labels, in this order: \
                {labels}. {fill} A field holds plain prose; its label is added for you.{meanings}")
        };
        format!(
            "{kind} {shape} Every note or field must say something specific to the quoted words, the kind of \
             observation a good teacher or critic would make; do not restate the passage, and do not write \
             anything generic just to fill space."
        )
    }

    /// Check the fields an assistant sent and turn them into labelled notes,
    /// in the preset's order. `quote` is the text the footnote is about.
    pub fn fold_fields(&self, fields: &[NoteField], quote: &str) -> Result<Vec<String>, String> {
        if fields.is_empty() {
            if self.fill == "all" && self.fields.iter().any(|label| !is_helps_with(label)) {
                return Err(format!("fill every field: {}", self.fields.join(", ")));
            }
            return Ok(Vec::new());
        }
        if self.fields.is_empty() {
            return Err("this request is free-form: write notes, not fields".into());
        }
        struct Placed { slot: usize, label: String, text: String, key: String }
        let quote_key = squeezed(quote);
        let mut placed: Vec<Placed> = Vec::new();
        for field in fields {
            let label = field.label.trim();
            let Some(slot) = self.fields.iter().position(|allowed| allowed.trim().eq_ignore_ascii_case(label)) else {
                return Err(format!("\"{label}\" is not one of this request's fields: {}", self.fields.join(", ")));
            };
            if placed.iter().any(|seen| seen.slot == slot) {
                return Err(format!("the field \"{label}\" appears twice"));
            }
            let text = field.text.trim();
            if text.chars().count() > 1500 {
                return Err(format!("the field \"{label}\" is longer than 1500 characters"));
            }
            if !is_helps_with(label) && text.split_whitespace().count() < MIN_FIELD_WORDS {
                return Err(format!("the field \"{label}\" is too thin: say something specific about the passage, in a full sentence"));
            }
            let key = squeezed(text);
            if !quote_key.is_empty() && (key == quote_key || (key.len() >= 12 && quote_key.contains(&key))) {
                return Err(format!("the field \"{label}\" only repeats the quoted text; explain it instead"));
            }
            if let Some(other) = placed.iter().find(|seen| seen.key.contains(&key) || key.contains(&seen.key)) {
                return Err(format!("the fields \"{}\" and \"{label}\" say the same thing; make each one count", other.label));
            }
            placed.push(Placed { slot, label: self.fields[slot].trim().to_string(), text: text.to_string(), key });
        }
        if self.fill == "all" {
            let missing: Vec<&str> = self.fields.iter().enumerate()
                .filter(|(at, label)| !is_helps_with(label) && !placed.iter().any(|seen| seen.slot == *at))
                .map(|(_, label)| label.as_str())
                .collect();
            if !missing.is_empty() {
                return Err(format!("fill every field; missing: {}", missing.join(", ")));
            }
        }
        placed.sort_by_key(|seen| seen.slot);
        Ok(placed.into_iter().map(|seen| format!("**{}:** {}", seen.label, seen.text)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn story(fill: &str) -> ReadingStyle {
        ReadingStyle {
            kind: "story".into(),
            fields: vec!["Context".into(), "Character".into(), "Theme".into()],
            fill: fill.into(),
            preset: "Reading companion".into(),
        }
    }

    fn field(label: &str, text: &str) -> NoteField { NoteField { label: label.into(), text: text.into() } }

    #[test]
    fn helps_with_is_a_short_list_and_optional_when_all_fields_are_asked() {
        let style = ReadingStyle {
            kind: "textbook".into(),
            fields: vec!["Idea".into(), HELPS_WITH.into(), "Think about it".into()],
            fill: "all".into(),
            preset: String::new(),
        };
        let guide = style.guide();
        assert!(guide.contains("never their answers"));
        assert!(guide.contains("without giving its answer away"));
        assert!(!guide.contains("Looking ahead hints"));
        let idea = field("Idea", "Finishing order, not discovery order, is what topological sort reads off.");
        let ask = field("Think about it", "Which vertex could finish last if the graph had a cycle?");
        // Nothing attached is a task: Helps with is left out, and that is complete.
        assert_eq!(style.fold_fields(&[idea.clone(), ask.clone()], "DFS").unwrap().len(), 2);
        // A short list is its whole point.
        let notes = style.fold_fields(&[idea, field("helps with", "Exercise 3.4, HW 2(b)"), ask], "DFS").unwrap();
        assert_eq!(notes[1], "**Helps with:** Exercise 3.4, HW 2(b)");
        // Other fields still have to be filled.
        assert!(style.fold_fields(&[field(HELPS_WITH, "Exercise 3.4")], "DFS").unwrap_err().contains("missing: Idea, Think about it"));
        // Free-form notes may name tasks too.
        assert!(ReadingStyle { kind: "story".into(), ..Default::default() }.guide().contains("**Helps with:**"));
    }

    #[test]
    fn styles_are_checked() {
        assert!(story("best").validate().is_ok());
        assert!(ReadingStyle { kind: "poem".into(), ..Default::default() }.validate().is_err());
        assert!(ReadingStyle { kind: "story".into(), fill: "best".into(), ..Default::default() }.validate().is_err());
        assert!(ReadingStyle { fields: vec!["A".into(), "a".into()], fill: "all".into(), ..Default::default() }.validate().is_err());
        assert!(ReadingStyle { fields: vec!["A".into()], fill: "some".into(), ..Default::default() }.validate().is_err());
    }

    #[test]
    fn guides_follow_the_kind_and_the_fields() {
        let free = ReadingStyle { kind: "story".into(), ..Default::default() }.guide();
        assert!(free.contains("Never mention anything that happens after"));
        assert!(free.contains("free-form"));
        assert!(!free.contains("problem"));
        let fields = story("all").guide();
        assert!(fields.contains("Context, Character, Theme"));
        assert!(fields.contains("Fill every one"));
        assert!(ReadingStyle { kind: "textbook".into(), ..Default::default() }.guide().contains("never solve a problem"));
    }

    #[test]
    fn best_fit_keeps_the_presets_order_and_only_what_was_sent() {
        let notes = story("best").fold_fields(&[
            field("theme", "Pride is set against prejudice as a matter of first impressions."),
            field("Character", "Darcy's stiffness reads as pride, though it may also be shyness."),
        ], "Mr. Darcy bowed coldly").unwrap();
        assert_eq!(notes, [
            "**Character:** Darcy's stiffness reads as pride, though it may also be shyness.",
            "**Theme:** Pride is set against prejudice as a matter of first impressions.",
        ]);
    }

    #[test]
    fn thin_repeated_or_unknown_fields_are_sent_back() {
        let style = story("best");
        let quote = "Mr. Darcy bowed coldly to the whole assembled company";
        for (name, fields) in [
            ("unknown", vec![field("Plot", "Something that is long enough to count as a sentence.")]),
            ("thin", vec![field("Character", "He is proud.")]),
            ("copy", vec![field("Character", "Mr. Darcy bowed coldly to the whole assembled company")]),
            ("twice", vec![field("Character", "Darcy's stiffness reads as pride, not shyness here."), field("Character", "Another note on the same character entirely.")]),
            ("same", vec![field("Character", "Darcy's stiffness reads as pride, not shyness here."), field("Theme", "Darcy's stiffness reads as pride, not shyness here.")]),
        ] {
            assert!(style.fold_fields(&fields, quote).is_err(), "{name}");
        }
        assert!(ReadingStyle::default().fold_fields(&[field("Context", "A field sent to a free-form request is refused.")], quote).is_err());
    }

    #[test]
    fn all_fields_means_every_field() {
        let style = story("all");
        let one = [field("Context", "The Netherfield ball is the town's first sight of Darcy.")];
        assert!(style.fold_fields(&one, "Mr. Darcy").unwrap_err().contains("Character, Theme"));
        assert!(style.fold_fields(&[], "Mr. Darcy").is_err());
    }
}
