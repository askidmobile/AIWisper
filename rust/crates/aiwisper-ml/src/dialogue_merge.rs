//! Word-level dialogue merge
//!
//! Merges mic and sys transcription segments into coherent dialogue,
//! handling overlaps, speaker changes, and word-level timestamps.

use aiwisper_types::{TranscriptSegment, TranscriptWord};

/// Constants for dialogue merging algorithm
const MAX_WORD_DURATION_MS: i64 = 2000; // Word cannot be > 2 seconds
const WORD_GAP_THRESHOLD_MS: i64 = 2000; // Gap > 2 sec = new phrase
const SEGMENT_MERGE_GAP_MS: i64 = 1000; // Merge same-speaker segments if gap < 1 sec
const OVERLAP_TOLERANCE_MS: i64 = 500; // Overlap < 500ms is timestamp error

/// Merge mic and sys segments into a unified dialogue
///
/// # Algorithm
/// 1. Fix anomalous word timestamps (> 2 sec duration)
/// 2. Split segments by word gaps (> 2 sec between words = new phrase)
/// 3. Merge segments with overlap handling
/// 4. Post-process: merge short consecutive phrases from same speaker
pub fn merge_words_to_dialogue(
    mic_segments: Vec<TranscriptSegment>,
    sys_segments: Vec<TranscriptSegment>,
) -> Vec<TranscriptSegment> {
    if mic_segments.is_empty() && sys_segments.is_empty() {
        return Vec::new();
    }

    // 1. Fix anomalous timestamps
    let mic_segments = fix_anomalous_timestamps(mic_segments);
    let sys_segments = fix_anomalous_timestamps(sys_segments);

    // 2. Split segments by word gaps
    let mic_segments = split_segments_by_word_gaps(mic_segments);
    let sys_segments = split_segments_by_word_gaps(sys_segments);

    tracing::debug!(
        "merge_words_to_dialogue: after split - mic={}, sys={} segments",
        mic_segments.len(),
        sys_segments.len()
    );

    // 3. Merge with overlap handling
    let result = merge_segments_with_overlap_handling(mic_segments, sys_segments);

    // 4. Post-process
    let result = post_process_dialogue(result);

    tracing::debug!(
        "merge_words_to_dialogue: final result = {} phrases",
        result.len()
    );

    result
}

/// Fix anomalously long word durations
/// Whisper sometimes gives words durations of several seconds
fn fix_anomalous_timestamps(mut segments: Vec<TranscriptSegment>) -> Vec<TranscriptSegment> {
    for segment in &mut segments {
        let words_len = segment.words.len();
        for j in 0..words_len {
            let duration = segment.words[j].end - segment.words[j].start;

            if duration > MAX_WORD_DURATION_MS {
                // Fix: word ends 500ms after start, or at next word start
                let mut new_end = segment.words[j].start + 500;
                if j + 1 < words_len {
                    let next_start = segment.words[j + 1].start;
                    if next_start < new_end {
                        new_end = next_start;
                    }
                }
                tracing::trace!(
                    "fix_anomalous_timestamps: word '{}' duration {}ms -> {}ms",
                    segment.words[j].text,
                    duration,
                    new_end - segment.words[j].start
                );
                segment.words[j].end = new_end;
            }
        }

        // Recalculate segment boundaries from words
        if !segment.words.is_empty() {
            segment.start = segment.words[0].start;
            segment.end = segment.words.last().unwrap().end;
        }
    }

    segments
}

/// Split segments into phrases based on word gaps
/// Gap > 2 seconds between words = new phrase
fn split_segments_by_word_gaps(segments: Vec<TranscriptSegment>) -> Vec<TranscriptSegment> {
    let mut result = Vec::new();

    for seg in segments {
        // If no words or few words - keep as is
        if seg.words.len() < 2 {
            result.push(seg);
            continue;
        }

        let mut current_words: Vec<TranscriptWord> = Vec::new();
        let mut current_start: i64 = 0;

        for (i, word) in seg.words.iter().enumerate() {
            if i == 0 {
                current_start = word.start;
                current_words.push(word.clone());
                continue;
            }

            let prev_word = &seg.words[i - 1];
            let gap = word.start - prev_word.end;

            if gap > WORD_GAP_THRESHOLD_MS {
                // Large gap - finalize current phrase and start new one
                let text = current_words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");

                tracing::trace!(
                    "split_segments_by_word_gaps: split at gap {}ms after '{}' (speaker: {:?})",
                    gap,
                    prev_word.text,
                    seg.speaker
                );

                result.push(TranscriptSegment {
                    start: current_start,
                    end: prev_word.end,
                    text,
                    speaker: seg.speaker.clone(),
                    words: std::mem::take(&mut current_words),
                    confidence: seg.confidence,
                });

                // Start new phrase
                current_start = word.start;
                current_words.push(word.clone());
            } else {
                // Continue current phrase
                current_words.push(word.clone());
            }
        }

        // Add last phrase
        if !current_words.is_empty() {
            let text = current_words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");

            result.push(TranscriptSegment {
                start: current_start,
                end: current_words.last().unwrap().end,
                text,
                speaker: seg.speaker.clone(),
                words: current_words,
                confidence: seg.confidence,
            });
        }
    }

    result
}

/// Tagged segment with source info (mic/sys)
struct TaggedSegment {
    segment: TranscriptSegment,
    is_mic: bool,
}

/// Merge segments with overlap handling
/// Works at segment level, preserving phrase integrity
fn merge_segments_with_overlap_handling(
    mic_segments: Vec<TranscriptSegment>,
    sys_segments: Vec<TranscriptSegment>,
) -> Vec<TranscriptSegment> {
    // 1. Tag each segment with source
    let mut all_segments: Vec<TaggedSegment> = Vec::new();

    for seg in mic_segments {
        all_segments.push(TaggedSegment {
            segment: seg,
            is_mic: true,
        });
    }
    for seg in sys_segments {
        all_segments.push(TaggedSegment {
            segment: seg,
            is_mic: false,
        });
    }

    if all_segments.is_empty() {
        return Vec::new();
    }

    // 2. Sort by start time
    all_segments.sort_by(|a, b| {
        if a.segment.start == b.segment.start {
            // Equal time - mic first (initiator)
            b.is_mic.cmp(&a.is_mic)
        } else {
            a.segment.start.cmp(&b.segment.start)
        }
    });

    // 3. Process overlaps and merge
    let mut result: Vec<TranscriptSegment> = Vec::new();

    for (i, tagged) in all_segments.into_iter().enumerate() {
        let mut seg = tagged.segment;

        // Set speaker
        if tagged.is_mic {
            if seg.speaker.is_none() || seg.speaker.as_deref() == Some("mic") {
                seg.speaker = Some("Вы".to_string());
            }
        } else if seg.speaker.is_none() || seg.speaker.as_deref() == Some("sys") {
            seg.speaker = Some("Собеседник".to_string());
        }

        if i == 0 {
            result.push(seg);
            continue;
        }

        let prev = result.last_mut().unwrap();

        // Check overlap
        let overlap = prev.end - seg.start;

        // Compare speakers exactly (important for diarization: "Собеседник 1" != "Собеседник 2")
        let same_speaker = prev.speaker == seg.speaker;

        if same_speaker {
            // Same speaker - check if we should merge
            let gap = seg.start - prev.end;
            if gap < SEGMENT_MERGE_GAP_MS {
                // Merge segments from same speaker
                prev.end = seg.end;
                prev.text = format!("{} {}", prev.text, seg.text);
                prev.words.extend(seg.words);
                continue;
            }
        } else {
            // Different speakers
            if overlap > 0 && overlap < OVERLAP_TOLERANCE_MS {
                // Small overlap - fix previous segment boundary
                tracing::trace!(
                    "merge_segments: correcting overlap {}ms between '{:?}' and '{:?}'",
                    overlap,
                    prev.speaker,
                    seg.speaker
                );
                if prev.end > seg.start {
                    prev.end = seg.start;
                }
            } else if overlap >= OVERLAP_TOLERANCE_MS {
                // Large overlap - real interruption, keep as is
                tracing::trace!(
                    "merge_segments: real interruption {}ms: '{:?}' interrupts '{:?}'",
                    overlap,
                    seg.speaker,
                    prev.speaker
                );
            }
        }

        result.push(seg);
    }

    result
}

/// Post-process dialogue: merge short consecutive phrases from same speaker
fn post_process_dialogue(phrases: Vec<TranscriptSegment>) -> Vec<TranscriptSegment> {
    if phrases.len() <= 1 {
        return phrases;
    }

    let mut result: Vec<TranscriptSegment> = Vec::new();

    for (i, phrase) in phrases.into_iter().enumerate() {
        if i == 0 {
            result.push(phrase);
            continue;
        }

        let prev = result.last_mut().unwrap();

        // Check if EXACTLY same speaker
        let same_speaker = prev.speaker == phrase.speaker;

        if same_speaker {
            let gap = phrase.start - prev.end;
            let prev_duration = prev.end - prev.start;
            let prev_word_count = prev.text.split_whitespace().count();

            // Merge conditions:
            // 1. Gap < 800ms AND previous phrase is short (< 2 sec)
            // 2. OR gap < 300ms (very short)
            // 3. OR previous phrase is one word AND gap < 1 sec
            let should_merge = (gap < 800 && prev_duration < 2000)
                || gap < 300
                || (gap < 1000 && prev_word_count == 1);

            if should_merge {
                prev.end = phrase.end;
                prev.text = format!("{} {}", prev.text, phrase.text);
                prev.words.extend(phrase.words);
                continue;
            }
        }

        result.push(phrase);
    }

    result
}

/// Check if speaker is microphone user
pub fn is_mic_speaker(speaker: &str) -> bool {
    speaker == "mic" || speaker == "Вы"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_word(start: i64, end: i64, text: &str) -> TranscriptWord {
        TranscriptWord {
            start,
            end,
            text: text.to_string(),
            confidence: 1.0,
        }
    }

    fn make_segment(
        start: i64,
        end: i64,
        text: &str,
        speaker: &str,
        words: Vec<TranscriptWord>,
    ) -> TranscriptSegment {
        TranscriptSegment {
            start,
            end,
            text: text.to_string(),
            speaker: Some(speaker.to_string()),
            words,
            confidence: 1.0,
        }
    }

    #[test]
    fn test_speaker_interleaving() {
        // Scenario:
        // Собеседник: "Может быть..." (0-2000ms)
        // Вы: "Так, давай-ка..." (1800-4000ms) - small overlap
        // Собеседник: "Будешь показывать?" (4200-5500ms)
        // Вы: "угу" (5600-5900ms) - short reply
        // Собеседник: "По-моему, да" (6000-7000ms)

        let mic_segments = vec![
            make_segment(
                1800,
                4000,
                "Так, давай-ка проверим",
                "Вы",
                vec![
                    make_word(1800, 2200, "Так,"),
                    make_word(2200, 2800, "давай-ка"),
                    make_word(2800, 4000, "проверим"),
                ],
            ),
            make_segment(5600, 5900, "угу", "Вы", vec![make_word(5600, 5900, "угу")]),
        ];

        let sys_segments = vec![
            make_segment(
                0,
                2000,
                "Может быть вот это",
                "Собеседник 1",
                vec![
                    make_word(0, 600, "Может"),
                    make_word(600, 1000, "быть"),
                    make_word(1000, 1400, "вот"),
                    make_word(1400, 2000, "это"),
                ],
            ),
            make_segment(
                4200,
                5500,
                "Будешь показывать?",
                "Собеседник 1",
                vec![
                    make_word(4200, 4800, "Будешь"),
                    make_word(4800, 5500, "показывать?"),
                ],
            ),
            make_segment(
                6000,
                7000,
                "По-моему, да",
                "Собеседник 1",
                vec![
                    make_word(6000, 6500, "По-моему,"),
                    make_word(6500, 7000, "да"),
                ],
            ),
        ];

        let result = merge_words_to_dialogue(mic_segments, sys_segments);

        // Should have at least 4 phrases
        assert!(result.len() >= 4, "Expected at least 4 phrases, got {}", result.len());

        // Check that short "угу" reply is not lost
        let found_ugu = result.iter().any(|p| p.text == "угу");
        assert!(found_ugu, "'угу' should not be lost");

        // Check order: first should be from sys (earlier timestamp)
        assert!(
            !is_mic_speaker(result[0].speaker.as_deref().unwrap_or("")),
            "First phrase should be from sys"
        );
    }

    #[test]
    fn test_fix_anomalous_timestamps() {
        let segments = vec![make_segment(
            0,
            5000,
            "test word",
            "Вы",
            vec![
                make_word(0, 500, "test"),
                make_word(500, 5000, "word"), // Anomalously long
            ],
        )];

        let fixed = fix_anomalous_timestamps(segments);

        // Second word should be shortened
        assert!(
            fixed[0].words[1].end - fixed[0].words[1].start <= MAX_WORD_DURATION_MS,
            "Word duration should be <= {}ms",
            MAX_WORD_DURATION_MS
        );
    }

    #[test]
    fn test_split_by_word_gaps() {
        let segments = vec![make_segment(
            0,
            10000,
            "first phrase second phrase",
            "Вы",
            vec![
                make_word(0, 500, "first"),
                make_word(500, 1000, "phrase"),
                make_word(5000, 5500, "second"), // 4 sec gap
                make_word(5500, 6000, "phrase"),
            ],
        )];

        let split = split_segments_by_word_gaps(segments);

        // Should be split into 2 phrases
        assert_eq!(split.len(), 2, "Should split into 2 phrases due to 4 sec gap");
        assert_eq!(split[0].text, "first phrase");
        assert_eq!(split[1].text, "second phrase");
    }
}
