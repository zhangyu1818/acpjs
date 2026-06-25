---
'@acpjs/registry': minor
---

Harden binary install against malicious archives and oversized downloads.

- Tar extraction now runs in-process via node-tar (new runtime dependency) instead of shelling out to the system `tar`. node-tar's security defaults are kept on, so a tar entry that uses `..` or a symlink to escape the extraction directory is refused.
- bzip2 tars (`.tar.bz2`, `.tbz2`) are no longer routed through the gzip tar path (node-tar does not decompress bzip2); they now reject with `registry/unsupported-archive` before download, alongside the installer formats.
- Downloads are buffered with a 1 GiB cap (overridable via the installer's `maxDownloadBytes`); exceeding it throws `registry/download-failed`.
- Each deflate zip entry is capped at 256 MiB of inflated output (zip-bomb guard), in addition to the existing zip-slip path guard.
