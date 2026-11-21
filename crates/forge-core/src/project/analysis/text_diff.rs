use serde::{Deserialize, Serialize};

use crate::Result;

const ALIGNMENT_CELLS: usize = 4_000_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum LineKind {
    Context,
    Removed,
    Added,
}

#[derive(Deserialize, Serialize)]
struct Block {
    kind: LineKind,
    text: String,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct TextDiff {
    blocks: Vec<Block>,
    pub rows: usize,
    pub added: usize,
    pub removed: usize,
    pub alignment_limited: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    kind: LineKind,
    left_line: Option<usize>,
    right_line: Option<usize>,
    text: String,
    terminated: bool,
}

impl TextDiff {
    fn push(&mut self, kind: LineKind, line: &str) {
        self.rows += 1;
        match kind {
            LineKind::Removed => self.removed += 1,
            LineKind::Added => self.added += 1,
            LineKind::Context => {}
        }
        if let Some(block) = self.blocks.last_mut().filter(|block| block.kind == kind) {
            block.text.push_str(line);
        } else {
            self.blocks.push(Block {
                kind,
                text: line.into(),
            });
        }
    }

    pub(super) fn page(&self, offset: usize, end: usize) -> Vec<DiffLine> {
        let (mut left, mut right) = (0, 0);
        self.blocks
            .iter()
            .flat_map(|block| {
                block
                    .text
                    .split_inclusive('\n')
                    .map(|line| (block.kind, line))
            })
            .take(end)
            .enumerate()
            .filter_map(|(index, (kind, line))| {
                let left_line = if kind != LineKind::Added {
                    left += 1;
                    Some(left)
                } else {
                    None
                };
                let right_line = if kind != LineKind::Removed {
                    right += 1;
                    Some(right)
                } else {
                    None
                };
                (index >= offset).then(|| DiffLine {
                    kind,
                    left_line,
                    right_line,
                    text: line.strip_suffix('\n').unwrap_or(line).into(),
                    terminated: line.ends_with('\n'),
                })
            })
            .collect()
    }
}

pub(super) fn compare(
    left: &str,
    right: &str,
    checkpoint: &mut impl FnMut() -> Result<()>,
) -> Result<TextDiff> {
    let left = left.replace("\r\n", "\n");
    let right = right.replace("\r\n", "\n");
    let left: Vec<_> = left.split_inclusive('\n').collect();
    let right: Vec<_> = right.split_inclusive('\n').collect();
    let prefix = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    let suffix = left[prefix..]
        .iter()
        .rev()
        .zip(right[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let mut diff = TextDiff::default();
    for line in &left[..prefix] {
        diff.push(LineKind::Context, line);
    }
    let removed = &left[prefix..left.len() - suffix];
    let added = &right[prefix..right.len() - suffix];
    let width = added.len() + 1;
    let cells = (removed.len() + 1).saturating_mul(width);
    if removed.is_empty() || added.is_empty() || cells > ALIGNMENT_CELLS {
        diff.alignment_limited = !removed.is_empty() && !added.is_empty();
        for line in removed {
            diff.push(LineKind::Removed, line);
        }
        for line in added {
            diff.push(LineKind::Added, line);
        }
    } else {
        let mut lcs = vec![0_u32; cells];
        for (i, line) in removed.iter().enumerate().rev() {
            checkpoint()?;
            for (j, other) in added.iter().enumerate().rev() {
                lcs[i * width + j] = if line == other {
                    lcs[(i + 1) * width + j + 1] + 1
                } else {
                    lcs[(i + 1) * width + j].max(lcs[i * width + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < removed.len() || j < added.len() {
            if i < removed.len() && j < added.len() && removed[i] == added[j] {
                diff.push(LineKind::Context, removed[i]);
                i += 1;
                j += 1;
            } else if i < removed.len()
                && (j == added.len() || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
            {
                diff.push(LineKind::Removed, removed[i]);
                i += 1;
            } else {
                diff.push(LineKind::Added, added[j]);
                j += 1;
            }
        }
    }
    for line in &left[left.len() - suffix..] {
        diff.push(LineKind::Context, line);
    }
    checkpoint()?;
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Error;

    #[test]
    fn aligns_crlf_blanks_and_reports_missing_final_newline() {
        let diff = compare("same\r\n\r\nold\r\nend", "same\n\nnew\nend\n", &mut || {
            Ok(())
        })
        .unwrap();
        assert_eq!(diff.rows, 6);
        assert_eq!((diff.added, diff.removed), (2, 2));
        let page = diff.page(1, 6);
        assert_eq!(page[0].text, "");
        assert_eq!((page[0].left_line, page[0].right_line), (Some(2), Some(2)));
        assert_eq!(page[1].kind, LineKind::Removed);
        assert_eq!(page[2].text, "end");
        assert!(!page[2].terminated);
        assert_eq!(page[3].kind, LineKind::Added);
        assert_eq!(page[4].right_line, Some(4));
        assert!(page[4].terminated);
    }

    #[test]
    fn bounds_alignment_and_still_returns_all_changes() {
        let before = "remove\n".repeat(2500);
        let after = "add\n".repeat(2500);
        let diff = compare(&before, &after, &mut || Ok(())).unwrap();
        assert!(diff.alignment_limited);
        assert_eq!((diff.added, diff.removed), (2500, 2500));
        let edge = diff.page(2499, 2501);
        assert_eq!(edge[0].left_line, Some(2500));
        assert_eq!(edge[1].right_line, Some(1));
    }

    #[test]
    fn aligns_edits_between_unchanged_lines_and_observes_cancellation() {
        let left = "same\nold\nsteady\nkeep\n";
        let right = "same\nnew\nsteady\nkeep\n";
        let diff = compare(left, right, &mut || Ok(())).unwrap();
        assert_eq!(
            diff.page(1, 4)
                .iter()
                .map(|line| line.kind)
                .collect::<Vec<_>>(),
            [LineKind::Removed, LineKind::Added, LineKind::Context]
        );
        let stopped = compare(left, right, &mut || Err(Error::AnalysisCanceled));
        assert!(matches!(stopped, Err(Error::AnalysisCanceled)));
    }
}
