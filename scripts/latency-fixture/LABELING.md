# Labelling a sermon transcript

You are building the answer key for a worship app that listens to a live sermon and puts the Bible verse the preacher cites on the projector, then shows summary slides. Your labels are the ground truth the app is scored against, so be careful and literal.

Input: `fixtures/real/txt/<slug>.txt`, a machine transcript (large Whisper model) of a recorded sermon from a Ghanaian church in English. Each line is `[start-end] text` with times in seconds. The transcript has mistakes, especially book names and numbers ("Matthew 1.7, the Lord is good, a stronghold" is really Nahum 1:7). Use the surrounding words and the verse text the preacher reads to work out what was actually said.

Output: write `fixtures/real/labels/<slug>.labels.json`:

```json
{
  "refs": [
    {
      "label": "Mark 2:5",
      "kind": "explicit",
      "spoken_start_s": 771,
      "spoken_end_s": 778,
      "heard": "exact words from the transcript where it is cited, 4 to 15 words",
      "note": "optional: why, if you corrected a misheard name or number"
    }
  ],
  "summary": {
    "title": "the sermon's title or theme as the preacher states it, else your best short title",
    "big_idea": "one sentence a congregation member could repeat",
    "points": [
      { "text": "main point in at most 12 words", "verses": ["Mark 2:5"] }
    ]
  },
  "notes": "anything unusual: long prayer, music, other language, recording quality"
}
```

## `kind`, exactly one of

- `explicit`: the preacher names a book, chapter and verse (or range) aloud, e.g. "turn with me to Mark chapter 2 verse 1", "Romans 8 28", "first John 1 and 9". This is what the app must catch. Label it even if the transcript garbled it, when context makes the intended verse clear.
- `chapter`: book and chapter only ("open to Mark chapter 2").
- `followup`: a verse number only, inside a passage already open ("verse 6 now says..."). Give the full label (Mark 2:6).
- `quote`: quotes or closely paraphrases a verse without citing it. Label only when you are confident which verse; skip common phrases.

Do not label hymn lyrics, announcements, or references in the opening/closing prayers unless cited as scripture to read.

## Label format

Book names exactly as: Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, 1 Samuel, 2 Samuel, 1 Kings, 2 Kings, 1 Chronicles, 2 Chronicles, Ezra, Nehemiah, Esther, Job, Psalms, Proverbs, Ecclesiastes, Song of Solomon, Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, Obadiah, Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, Matthew, Mark, Luke, John, Acts, Romans, 1 Corinthians, 2 Corinthians, Galatians, Ephesians, Philippians, Colossians, 1 Thessalonians, 2 Thessalonians, 1 Timothy, 2 Timothy, Titus, Philemon, Hebrews, James, 1 Peter, 2 Peter, 1 John, 2 John, 3 John, Jude, Revelation.

`Book C:V`, `Book C:V-E` for a range, `Book C` for chapter-only.

## Times

`spoken_start_s` / `spoken_end_s`: start of the line where the citation begins, end of the line where it finishes. If a reference repeats ("Romans 8 28... Romans 8 verse 28"), label each time it is said aloud, since the app may catch either.

## Summary

Write the summary a skilled church media volunteer would put on the closing slide: the title as stated (listen for "my topic is", "the title of the message"), a one-sentence big idea, and 2 to 5 main points with the verses that support each. If the preacher numbers points, use theirs.

Read the whole transcript. Do not guess verses you cannot support from the text. Validate your JSON parses before finishing (`python3 -m json.tool file`).
