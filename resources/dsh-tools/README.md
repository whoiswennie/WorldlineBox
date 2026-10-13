# DSH archive extractor notices

WorldlineBox uses the unmodified Windows x64 7za executable distributed by `7zip-bin@5.2.0` (7-Zip 21.07). The npm package and its integrity are pinned in `package-lock.json`; executable files remain outside ASAR so a separate process can run them.

`7zip-bin-LICENSE.txt` covers the MIT wrapper. `7zip-license.txt` and `LGPL-2.1.txt` contain upstream distribution notices and the LGPL text. Original 7-Zip source and historical release downloads are available at https://www.7-zip.org/download.html and https://sourceforge.net/projects/sevenzip/files/7-Zip/21.07/.

DSH runtime artifacts are downloaded or locally imported by the user and retain their original license files. They are not bundled into WorldlineBox releases. Backups produced by the user include the selected runtime for local offline restoration.
