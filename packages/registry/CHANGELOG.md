# @acpjs/registry

## 0.2.1

### Patch Changes

- Updated dependencies [52f041c]
  - @acpjs/protocol@0.7.0

## 0.2.0

### Minor Changes

- 0b7c668: Harden binary install against malicious archives and oversized downloads.

  - Tar extraction now runs in-process via node-tar (new runtime dependency) instead of shelling out to the system `tar`. node-tar's security defaults are kept on, so a tar entry that uses `..` or a symlink to escape the extraction directory is refused.
  - bzip2 tars (`.tar.bz2`, `.tbz2`) are no longer routed through the gzip tar path (node-tar does not decompress bzip2); they now reject with `registry/unsupported-archive` before download, alongside the installer formats.
  - Downloads are buffered with a 1 GiB cap (overridable via the installer's `maxDownloadBytes`); exceeding it throws `registry/download-failed`.
  - Each deflate zip entry is capped at 256 MiB of inflated output (zip-bomb guard), in addition to the existing zip-slip path guard.

### Patch Changes

- Updated dependencies [2ab76be]
- Updated dependencies [0b7c668]
  - @acpjs/protocol@0.6.0

## 0.1.5

### Patch Changes

- Updated dependencies [b6a0f0b]
- Updated dependencies [7ce1084]
  - @acpjs/protocol@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [4e438f4]
  - @acpjs/protocol@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [214cae3]
  - @acpjs/protocol@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [5c85002]
  - @acpjs/protocol@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [d581617]
  - @acpjs/protocol@0.2.0
