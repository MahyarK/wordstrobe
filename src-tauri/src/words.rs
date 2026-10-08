//! Building the text of an OCR line from its words, for the two engines that report words
//! (`Windows.Media.Ocr` and Tesseract). Compiled on every OS but macOS, whose Vision helper reports
//! whole lines; the tests also run there.

/// Words joined by spaces, except between two characters of a script that is written without
/// spaces: the Chinese, Japanese and Thai models of both engines put a gap between every character.
/// Hangul is spaced like Latin text, so it keeps its spaces.
pub fn join_words(words: &[String]) -> String {
    let mut text = String::new();
    for word in words {
        let glued = text.chars().next_back().zip(word.chars().next()).is_some_and(
            |(a, b)| is_unspaced_script(a) && is_unspaced_script(b),
        );
        if !text.is_empty() && !glued {
            text.push(' ');
        }
        text.push_str(word);
    }
    text
}

fn is_unspaced_script(c: char) -> bool {
    matches!(c as u32,
        0x0E00..=0x0EFF   // Thai, Lao
        | 0x1000..=0x109F // Myanmar
        | 0x1780..=0x17FF // Khmer
        | 0x3000..=0x30FF // CJK punctuation, Hiragana, Katakana
        | 0x31F0..=0x31FF // Katakana extensions
        | 0x3400..=0x4DBF // CJK extension A
        | 0x4E00..=0x9FFF // CJK unified ideographs
        | 0xF900..=0xFAFF // CJK compatibility ideographs
        | 0xFF00..=0xFFEF // fullwidth forms
        | 0x20000..=0x2FA1F // CJK extensions B-F, compatibility supplement
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn join(words: &[&str]) -> String {
        join_words(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn cjk_characters_are_not_split_by_spaces() {
        assert_eq!(
            join(&["你", "好", "世", "界", "Hello", "world", "こ", "ん"]),
            "你好世界 Hello world こん"
        );
    }

    #[test]
    fn latin_words_and_hangul_keep_their_spaces() {
        assert_eq!(join(&["Rapid", "serial", "visual"]), "Rapid serial visual");
        assert_eq!(join(&["안녕하세요", "세계"]), "안녕하세요 세계");
        assert_eq!(join(&["Über", "straße", "5"]), "Über straße 5");
    }

    #[test]
    fn cjk_words_and_punctuation_run_together_but_not_into_latin_neighbours() {
        assert_eq!(join(&["日本語", "の", "文章", "。", "Next", "line"]), "日本語の文章。 Next line");
        assert_eq!(join(&["abc", "漢字", "def"]), "abc 漢字 def");
    }

    #[test]
    fn no_words_no_text() {
        assert_eq!(join(&[]), "");
    }
}
