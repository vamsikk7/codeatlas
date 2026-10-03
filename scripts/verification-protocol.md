# Real-repo state.json verification protocol

For each assigned project at `e2e/real-repos/<id>/`:

## Inputs available
- `e2e/real-repos/<id>/.codeatlas/state.json` — the snapshot CodeAtlas produced
- `e2e/real-repos/<id>/...` — the real source code we ran against

## Schema (top-level keys you'll see)
- `working.files[<path>]` → `{ relativePath, mtime, content?, symbols }`
- `working.apiIndex[<apiId>]` → `{ apiId, method, route, handlerName, filePath, anchor }`
- `working.graphs[<graphId>]` → `{ graphId, nodes[], edges[], meta? }`
  - `microservice:workspace` (L1)
  - `feature:workspace`, `feature:<serviceId>` (L2a)
  - `api-list:<clusterId>` + sub-clusters (L2b)
  - `sequence:<filePath>:<handler>` (L3)
  - `file:<filePath>` (L4)
  - `flow:<filePath>:<funcName>` (L5)
  - `health:report`
- `working.clusters[<id>]`, `working.services[<id>]`

## Checks (run all, report every finding)

### 1. Broken file paths
For every node with `anchor.filePath`:
- Strip leading `/` if present
- `fs.existsSync(path.join(repoPath, anchor.filePath))` must be true
- Report any miss as **HIGH** severity. Include graphId, nodeId, the path.

### 2. Symbol-vs-source mismatch (spot-check at most 5 per layer)
For nodes with `anchor.symbol`:
- Read the file
- Confirm the symbol text appears at least once. (Plain string match is fine — we're catching dangling references, not parser bugs.)
- For function/flow nodes, confirm the symbol appears as a function/method declaration.
- Anonymous handlers named `anonymous@<METHOD>:/<route>` are exempt from symbol-text match — instead confirm the route+method tuple is in `working.apiIndex`.

### 3. Dangling edges
For every edge in every graph:
- Both `source` and `target` must exist as node IDs in the same graph's `nodes[]`.
- Report any miss as **HIGH**. Include graphId + edge object.

### 4. Layer cross-references
- Every `meta.clusterId` referenced from L1 microservice or L2b api-list must exist in `working.clusters`.
- Every API in L2b's `meta.apis[]` must have `apiId` present in `working.apiIndex`.
- Every L3 sequence handler that's not anonymous@ must have a matching L5 flow graph (graphId starts with `flow:`).
- Every L4 file graph's path must be present in `working.files`.

### 5. Subsystem dangling
L2b api-list `meta.subsystems[]` items with `filePath` set must point to a real file in the repo.

### 6. Empty / trivial graph audit
- File graphs with **0** nodes — report as **MED** if the corresponding file has > 50 lines of code.
- Flow graphs with no `terminal` end node and only a single statement node — report as **LOW** (likely a parse miss).

### 7. Sequence message integrity
Sequence graphs' `nodes[]` should include a participant for every distinct sender/receiver in `edges[]`. Missing participants → **MED**.

## Output format
Return JSON:
```json
{
  "id": "<projectId>",
  "fileCount": <number>,
  "apiCount": <number>,
  "graphCount": <number>,
  "findings": [
    { "severity": "HIGH|MED|LOW", "category": "broken_path|dangling_edge|...", "graphId": "...", "where": "...", "detail": "..." }
  ]
}
```

Cap findings per category at 5 per project (note "+ N more" if truncated). Be concise.
