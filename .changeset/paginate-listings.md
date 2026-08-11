---
'jetbridge': patch
---

`bundles ls` and `bundles prune` now read every page from App Store Connect.

Apple caps a listing at 200 entries and returns a link to the next page. Reading only the first page looks correct on a small account and is quietly partial on a large one — which is the worst shape for a destructive command: `prune` classified only what it had seen, so it deleted fewer variants than it reported, and the listing did not shrink when one was removed. Found on an account with more than 200 registered ids.
