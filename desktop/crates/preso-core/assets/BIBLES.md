# Bundled Bible translations

Agent HSP compiles these translations into the app. Each one is free to redistribute. This file is the attribution the licences ask for. Keep it up to date when a translation is added or rebuilt.

| Id | Translation | Licence | Copyright holder | Source |
|----|-------------|---------|------------------|--------|
| `kjv` | King James Version | Public domain | None (Crown patent applies in the United Kingdom only) | `../kjv.json`; source not recorded |
| `asv` | American Standard Version (1901) | Public domain | None | `asv.json`; source not recorded |
| `web` | World English Bible | Public domain ("World English Bible" is a trademark of eBible.org) | None | `web.json`; source not recorded |
| `bbe` | Bible in Basic English | Public domain | None | `bbe.json`; source not recorded |
| `bsb` | Berean Standard Bible (BSB) | Public domain (CC0 1.0 since 2023) | BSB Publishing, LLC (contributor) | https://eBible.org/Scriptures/engbsb_usfm.zip, https://bereanbible.com |
| `lsv` | Literal Standard Version (LSV) | Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0) | © 2020 Covenant Press and the Covenant Christian Coalition | https://eBible.org/Scriptures/englsv_usfm.zip, https://lsvbible.com |
| `fbv` | Free Bible Version (FBV) | Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0) | © 2018 Dr. Jonathan Gallagher | https://eBible.org/Scriptures/engfbv_usfm.zip, https://freebibleversion.org |

Licence text: https://creativecommons.org/licenses/by-sa/4.0/ and https://creativecommons.org/publicdomain/zero/1.0/

## What the licence pages say

Quoted from `copr.htm` inside each eBible.org zip (files dated 2 October 2026).

- BSB: "The Holy Bible in English: Berean Standard Bible. Public Domain. Contributor: BSB Publishing, LLC."
- LSV: "The Holy Bible in English, Literal Standard Version, copyright © 2020 Covenant Press ... This translation is made available to you under the terms of the Creative Commons Attribution Share-Alike license 4.0. You have permission to share and redistribute this Bible translation in any format and to make reasonable revisions and adaptations of this translation, provided that: You include the above copyright and source information. If you make any changes to the text, you must indicate that you did so ... If you redistribute this text, you must distribute your contributions under the same license as the original."
- FBV: "Copyright © 2018 Dr. Jonathan Gallagher ... made available to you under the terms of the Creative Commons Attribution Share-Alike license 4.0", with the same three conditions as the LSV.

## Changes made to the text

`bsb.json`, `lsv.json` and `fbv.json` were built from the eBible.org USFM files with `scripts/bibles/usfm2json.py`. The words of each verse are unchanged. The converter only removes material that cannot go on a one-verse slide:

1. Footnotes, cross references, section headings, book introductions and Strong's number tags are removed.
2. Psalm titles (superscriptions) are removed from verse 1. The LSV prints them in capitals at the start of verse 1; that capitalised title is cut.
3. Poetry line breaks become spaces. The LSV's "||" line-break mark and its acrostic letter tags (for example "[ALEPH]" in Psalm 119) are removed.
4. Verses a translation leaves out (for example Matthew 17:21 in the BSB and FBV) are stored as empty text so later verses keep their numbers.

These are format changes by the Agent HSP project. Covenant Press and Dr. Jonathan Gallagher have not reviewed or endorsed them.

## ShareAlike

`lsv.json` and `fbv.json` are adaptations of CC BY-SA 4.0 works. They are distributed under CC BY-SA 4.0, whatever licence the rest of Agent HSP uses. Anyone may reuse them on the same terms.

## Rebuilding

```sh
curl -LO https://eBible.org/Scriptures/engbsb_usfm.zip
python3 scripts/bibles/usfm2json.py engbsb_usfm.zip --id bsb \
  --name "Berean Standard Bible (BSB)" -o desktop/crates/preso-core/assets/bsb.json
```

Use `englsv_usfm.zip` with `--id lsv --name "Literal Standard Version (LSV)"`, and `engfbv_usfm.zip` with `--id fbv --name "Free Bible Version (FBV)"`. Read `copr.htm` in each new zip first and stop if the licence has changed.
