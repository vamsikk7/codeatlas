```jsx
// src/App.jsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

// Babel traverse interop (vite/esbuild can expose default)
const traverse = traverseModule.default || traverseModule;

// ---------- Constants ----------
const NODE_WIDTH = 280;
const NODE_HEIGHT = 82;

// ---------- React Flow custom node ----------
function DiffNode({ data }) {
  const { label, kind, diff } = data;
  const isDecision = kind === "decision";
  const isTerminal = kind === "terminal";

  const baseStyle = {
    border: "1px solid #94a3b8",
    background: "#fff",
    minWidth: NODE_WIDTH,
    minHeight: NODE_HEIGHT,
    fontSize: 12,
    color: "#0f172a",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
    borderRadius: isTerminal ? 999 : isDecision ? 12 : 8,
    transform: isDecision ? "rotate(45deg)" : "none",
  };

  const innerStyle = {
    transform: isDecision ? "rotate(-45deg)" : "none",
    padding: diff ? 0 : "8px 10px",
    textAlign: "center",
    whiteSpace: "pre-wrap",
    lineHeight: 1.25,
  };

  if (diff) {
    return (
      <div style={baseStyle}>
        <div style={innerStyle}>
          {diff.deleted ? (
            <div
              style={{
                background: "#fecaca",
                color: "#7f1d1d",
                padding: "5px 8px",
                borderBottom: diff.added ? "1px solid #fca5a5" : "none",
                textAlign: "left",
                fontFamily: "ui-monospace, Menlo, monospace",
                transform: isDecision ? "scale(0.85)" : "none",
                whiteSpace: "pre-wrap",
              }}
            >
              <span style={{ marginRight: 6, fontWeight: 700 }}>-</span>
              <span style={{ textDecoration: "line-through" }}>{diff.deleted}</span>
            </div>
          ) : null}
          {diff.added ? (
            <div
              style={{
                background: "#bbf7d0",
                color: "#14532d",
                padding: "5px 8px",
                textAlign: "left",
                fontFamily: "ui-monospace, Menlo, monospace",
                transform: isDecision ? "scale(0.85)" : "none",
                whiteSpace: "pre-wrap",
              }}
            >
              <span style={{ marginRight: 6, fontWeight: 700 }}>+</span>
              <strong>{diff.added}</strong>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={baseStyle}>
      <div
        style={{
          ...innerStyle,
          fontWeight: isTerminal ? 600 : 400,
          transform: isDecision ? "rotate(-45deg) scale(0.9)" : "none",
          maxWidth: isDecision ? 190 : "unset",
          margin: "0 auto",
        }}
      >
        {label}
      </div>
    </div>
  );
}

const nodeTypes = { diffNode: DiffNode };

// ---------- Dagre layout ----------
function getLayoutedElements(nodes, edges, direction = "TB") {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    ranksep: 80,
    nodesep: 60,
    marginx: 20,
    marginy: 20,
  });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const layoutedNodes = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      position: { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 },
      targetPosition: direction === "TB" ? Position.Top : Position.Left,
      sourcePosition: direction === "TB" ? Position.Bottom : Position.Right,
    };
  });

  return { nodes: layoutedNodes, edges };
}

// ---------- Helpers ----------
let ID = 0;
function nextId(prefix = "id") {
  ID += 1;
  return `${prefix}_${ID}`;
}

function createNode(label, kind = "action", diff = null) {
  return {
    id: nextId("node"),
    type: "diffNode",
    data: { label, kind, diff },
    position: { x: 0, y: 0 },
  };
}

function createEdge(source, target, label) {
  return {
    id: nextId("edge"),
    source,
    target,
    label,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { strokeWidth: 1.4 },
    labelStyle: { fontSize: 11, fill: "#0f172a" },
  };
}

function srcText(node, source) {
  if (!node || node.start == null || node.end == null) return "";
  return source.slice(node.start, node.end).trim();
}

function normalizeSpace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function readableNodeText(stmt, source) {
  const raw = normalizeSpace(srcText(stmt, source));

  switch (stmt.type) {
    case "VariableDeclaration":
    case "ExpressionStatement":
    case "ReturnStatement":
    case "ThrowStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return raw || stmt.type;
    case "IfStatement":
      return `is ${normalizeSpace(srcText(stmt.test, source)) || "condition"}?`;
    case "ForStatement":
      return `for (${normalizeSpace(srcText(stmt.init, source) || "")}; ${normalizeSpace(
        srcText(stmt.test, source) || ""
      )}; ${normalizeSpace(srcText(stmt.update, source) || "")})`;
    case "WhileStatement":
      return `while (${normalizeSpace(srcText(stmt.test, source)) || "condition"})`;
    default:
      return raw || stmt.type;
  }
}

function statementKey(stmt, source) {
  const text = normalizeSpace(srcText(stmt, source))
    .replace(/;$/, "")
    .replace(/\b\d+(\.\d+)?\b/g, "#")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"STR"');
  return `${stmt.type}:${text}`;
}

// ---------- AST function extraction (single function only) ----------
function parseFirstFunction(code) {
  const ast = parse(code, {
    sourceType: "module",
    plugins: [],
    ranges: true,
    errorRecovery: false,
  });

  let targetFn = null;

  traverse(ast, {
    FunctionDeclaration(path) {
      if (!targetFn) targetFn = path.node;
    },
    VariableDeclarator(path) {
      if (targetFn) return;
      const init = path.node.init;
      if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
        targetFn = { ...init, id: path.node.id };
      }
    },
  });

  if (!targetFn) {
    throw new Error(
      "No JavaScript function found. Paste a function declaration or arrow/function expression."
    );
  }

  const bodyStatements =
    targetFn.body.type === "BlockStatement"
      ? targetFn.body.body
      : [
          {
            type: "ReturnStatement",
            argument: targetFn.body,
            start: targetFn.body.start,
            end: targetFn.body.end,
          },
        ];

  return { fn: targetFn, bodyStatements };
}

function flattenStatements(statements, out = []) {
  for (const stmt of statements) {
    if (!stmt) continue;
    out.push(stmt);

    if (stmt.type === "BlockStatement") {
      flattenStatements(stmt.body, out);
    } else if (stmt.type === "IfStatement") {
      flattenStatements([stmt.consequent], out);
      if (stmt.alternate) flattenStatements([stmt.alternate], out);
    } else if (stmt.type === "ForStatement" || stmt.type === "WhileStatement") {
      flattenStatements([stmt.body], out);
    }
  }
  return out;
}

// ---------- Diff map builder (old/new code -> node overlays) ----------
function buildDiffMap(oldCode, newCode) {
  const oldFn = parseFirstFunction(oldCode);
  const newFn = parseFirstFunction(newCode);

  const oldFlat = flattenStatements(oldFn.bodyStatements, []).filter((s) => s.type !== "BlockStatement");
  const newFlat = flattenStatements(newFn.bodyStatements, []).filter((s) => s.type !== "BlockStatement");

  const oldTexts = oldFlat.map((s) => normalizeSpace(srcText(s, oldCode))).filter(Boolean);
  const newTexts = newFlat.map((s) => normalizeSpace(srcText(s, newCode))).filter(Boolean);

  const oldSet = new Set(oldTexts);
  const newSet = new Set(newTexts);

  // Removed statements bucketed by normalized key
  const keyToDeleted = new Map();
  oldFlat.forEach((stmt) => {
    const txt = normalizeSpace(srcText(stmt, oldCode));
    if (!txt || newSet.has(txt)) return;
    const key = statementKey(stmt, oldCode);
    if (!keyToDeleted.has(key)) keyToDeleted.set(key, []);
    keyToDeleted.get(key).push(txt);
  });

  // Pair "modified" statements by normalized key
  const exactAddedToDeleted = new Map();
  newFlat.forEach((stmt) => {
    const addedText = normalizeSpace(srcText(stmt, newCode));
    if (!addedText || oldSet.has(addedText)) return;

    const key = statementKey(stmt, newCode);
    const deletedBucket = keyToDeleted.get(key);
    if (deletedBucket && deletedBucket.length) {
      const deleted = deletedBucket.shift();
      exactAddedToDeleted.set(addedText, deleted);
    }
  });

  // Added-only set
  const addedExactSet = new Set(
    newFlat
      .map((s) => normalizeSpace(srcText(s, newCode)))
      .filter((txt) => txt && !oldSet.has(txt) && !exactAddedToDeleted.has(txt))
  );

  return { exactAddedToDeleted, addedExactSet };
}

function diffLabelForStatement(stmt, source, diffMap) {
  if (!diffMap) return null;

  const exact = normalizeSpace(srcText(stmt, source));
  if (!exact) return null;

  if (diffMap.exactAddedToDeleted.has(exact)) {
    return {
      deleted: diffMap.exactAddedToDeleted.get(exact),
      added: exact,
    };
  }

  if (diffMap.addedExactSet.has(exact)) {
    return { added: exact };
  }

  return null;
}

// ---------- Flow builder (single function only; no recursive called-function expansion) ----------
function buildStatement(stmt, source, nodes, edges, diffMap) {
  if (!stmt) return { entryId: null, exits: [], terminals: [] };

  if (stmt.type === "BlockStatement") {
    return buildBlock(stmt.body, source, nodes, edges, diffMap);
  }

  if (stmt.type === "IfStatement") {
    const decisionNode = createNode(readableNodeText(stmt, source), "decision");
    nodes.push(decisionNode);

    const cons = buildStatement(stmt.consequent, source, nodes, edges, diffMap);
    if (cons.entryId) edges.push(createEdge(decisionNode.id, cons.entryId, "Yes"));

    let alt = null;
    if (stmt.alternate) {
      alt = buildStatement(stmt.alternate, source, nodes, edges, diffMap);
      if (alt.entryId) edges.push(createEdge(decisionNode.id, alt.entryId, "No"));
    }

    const exits = [];
    const terminals = [...cons.terminals];
    cons.exits.forEach((e) => exits.push(e));

    if (alt) {
      alt.exits.forEach((e) => exits.push(e));
      terminals.push(...alt.terminals);
    } else {
      exits.push({ id: decisionNode.id, label: "No" });
    }

    return { entryId: decisionNode.id, exits, terminals };
  }

  if (stmt.type === "ForStatement" || stmt.type === "WhileStatement") {
    const loopNode = createNode(readableNodeText(stmt, source), "decision");
    nodes.push(loopNode);

    const bodyBuilt = buildStatement(stmt.body, source, nodes, edges, diffMap);
    if (bodyBuilt.entryId) edges.push(createEdge(loopNode.id, bodyBuilt.entryId, "Yes"));

    bodyBuilt.exits.forEach((ex) => edges.push(createEdge(ex.id, loopNode.id)));
    return {
      entryId: loopNode.id,
      exits: [{ id: loopNode.id, label: "No" }],
      terminals: [...bodyBuilt.terminals],
    };
  }

  const label = readableNodeText(stmt, source);
  const diff = diffLabelForStatement(stmt, source, diffMap);
  const actionNode = createNode(label, stmt.type === "ReturnStatement" ? "return" : "action", diff);
  nodes.push(actionNode);

  if (stmt.type === "ReturnStatement" || stmt.type === "ThrowStatement") {
    return { entryId: actionNode.id, exits: [], terminals: [actionNode.id] };
  }

  return { entryId: actionNode.id, exits: [{ id: actionNode.id }], terminals: [] };
}

function buildBlock(statements, source, nodes, edges, diffMap) {
  let entryId = null;
  let openExits = [];
  let terminals = [];

  for (const stmt of statements) {
    const built = buildStatement(stmt, source, nodes, edges, diffMap);
    if (!built.entryId) continue;

    if (!entryId) entryId = built.entryId;

    openExits.forEach((ex) => {
      edges.push(createEdge(ex.id, built.entryId, ex.label));
    });

    openExits = built.exits;
    terminals = terminals.concat(built.terminals);
  }

  return { entryId, exits: openExits, terminals };
}

function functionToFlowFromCode(code, diffMap = null) {
  ID = 0;
  const nodes = [];
  const edges = [];

  const { fn, bodyStatements } = parseFirstFunction(code);

  const fnName = fn.id?.name || "anonymous";
  const params = (fn.params || [])
    .map((p) => (p.type === "Identifier" ? p.name : "arg"))
    .join(", ");

  const start = createNode(`Start\n${fnName}(${params})`, "terminal");
  const end = createNode("End", "terminal");
  nodes.push(start, end);

  const built = buildBlock(bodyStatements, code, nodes, edges, diffMap);

  if (built.entryId) edges.push(createEdge(start.id, built.entryId));
  else edges.push(createEdge(start.id, end.id));

  built.exits.forEach((ex) => edges.push(createEdge(ex.id, end.id, ex.label)));
  built.terminals.forEach((id) => edges.push(createEdge(id, end.id)));

  return getLayoutedElements(nodes, edges, "TB");
}

// ---------- Unified git diff parser + reconstructor ----------
// Supports standard unified diff with @@ hunks.
// For reliable reconstruction, the diff should include enough context around the function.
function parseUnifiedDiff(diffText) {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");

  const files = [];
  let currentFile = null;
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (currentFile) files.push(currentFile);
      currentFile = {
        oldPath: line.slice(4).trim(),
        newPath: null,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (!currentFile) {
        currentFile = { oldPath: null, newPath: line.slice(4).trim(), hunks: [] };
      } else {
        currentFile.newPath = line.slice(4).trim();
      }
      continue;
    }

    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      if (!currentFile) {
        currentFile = { oldPath: null, newPath: null, hunks: [] };
      }
      currentHunk = {
        oldStart: Number(m[1]),
        oldCount: Number(m[2] || 1),
        newStart: Number(m[3]),
        newCount: Number(m[4] || 1),
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }

  if (currentFile) files.push(currentFile);

  return files;
}

function reconstructFromUnifiedDiff(diffText) {
  const files = parseUnifiedDiff(diffText);
  const file = files.find((f) => f.hunks.length > 0);

  if (!file) {
    throw new Error("No unified diff hunks found. Paste a standard git diff with @@ headers.");
  }

  const oldLines = [];
  const newLines = [];

  for (const hunk of file.hunks) {
    for (const raw of hunk.lines) {
      if (raw.startsWith("\\ No newline at end of file")) continue;

      if (raw.startsWith("+")) {
        // Added line exists only in new
        newLines.push(raw.slice(1));
      } else if (raw.startsWith("-")) {
        // Deleted line exists only in old
        oldLines.push(raw.slice(1));
      } else if (raw.startsWith(" ")) {
        // Context line exists in both
        const content = raw.slice(1);
        oldLines.push(content);
        newLines.push(content);
      } else {
        // metadata inside hunk; ignore
      }
    }
  }

  const oldCode = oldLines.join("\n");
  const newCode = newLines.join("\n");

  if (!oldCode.trim() && !newCode.trim()) {
    throw new Error("Could not reconstruct old/new code from diff hunks.");
  }

  return {
    oldCode,
    newCode,
    meta: {
      oldPath: file.oldPath,
      newPath: file.newPath,
      hunks: file.hunks.length,
    },
  };
}

// ---------- Sample inputs ----------
const SAMPLE_NEW = `function calculate_discount(price, is_member) {
  let discount = 0;

  if (is_member) {
    if (price > 100) {
      discount = price * 0.25;
    } else {
      discount = price * 0.10;
    }
  } else {
    discount = 0;
  }

  return discount;
}`;

const SAMPLE_OLD = `function calculate_discount(price, is_member) {
  let discount = 0;

  if (is_member) {
    if (price > 100) {
      discount = price * 0.20;
    } else {
      discount = price * 0.10;
    }
  } else {
    discount = 0;
  }

  return discount;
}`;

const SAMPLE_GIT_DIFF = `diff --git a/sample.js b/sample.js
index abc1234..def5678 100644
--- a/sample.js
+++ b/sample.js
@@ -1,14 +1,14 @@
 function calculate_discount(price, is_member) {
   let discount = 0;
 
   if (is_member) {
     if (price > 100) {
-      discount = price * 0.20;
+      discount = price * 0.25;
     } else {
       discount = price * 0.10;
     }
   } else {
     discount = 0;
   }
 
   return discount;
 }`;

// ---------- App ----------
export default function App() {
  const [mode, setMode] = useState("gitdiff"); // js | diff | gitdiff
  const [code, setCode] = useState(SAMPLE_NEW);
  const [oldCode, setOldCode] = useState(SAMPLE_OLD);
  const [newCode, setNewCode] = useState(SAMPLE_NEW);
  const [gitDiff, setGitDiff] = useState(SAMPLE_GIT_DIFF);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [error, setError] = useState("");
  const [reconInfo, setReconInfo] = useState(null);

  const generate = useCallback(() => {
    try {
      setError("");
      setReconInfo(null);

      if (mode === "js") {
        const res = functionToFlowFromCode(code, null);
        setNodes(res.nodes);
        setEdges(res.edges);
        return;
      }

      if (mode === "diff") {
        const diffMap = buildDiffMap(oldCode, newCode);
        const res = functionToFlowFromCode(newCode, diffMap);
        setNodes(res.nodes);
        setEdges(res.edges);
        return;
      }

      // gitdiff mode
      const { oldCode: oldRebuilt, newCode: newRebuilt, meta } = reconstructFromUnifiedDiff(gitDiff);
      setReconInfo(meta);

      const diffMap = buildDiffMap(oldRebuilt, newRebuilt);
      const res = functionToFlowFromCode(newRebuilt, diffMap);
      setNodes(res.nodes);
      setEdges(res.edges);
    } catch (e) {
      console.error(e);
      setError(
        e.message ||
          "Failed to generate flowchart. Make sure the diff includes a complete function body (or enough context)."
      );
      setNodes([]);
      setEdges([]);
    }
  }, [mode, code, oldCode, newCode, gitDiff]);

  useEffect(() => {
    generate();
  }, [generate]);

  const flow = useMemo(
    () => (
      <ReactFlow nodes={nodes} edges={edges} fitView nodeTypes={nodeTypes}>
        <MiniMap zoomable pannable />
        <Controls />
        <Background />
      </ReactFlow>
    ),
    [nodes, edges]
  );

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateColumns: "500px 1fr",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          borderRight: "1px solid #e2e8f0",
          padding: 14,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>JS Function → Differential Flowchart</h2>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ModeButton active={mode === "js"} onClick={() => setMode("js")}>
            JavaScript
          </ModeButton>
          <ModeButton active={mode === "diff"} onClick={() => setMode("diff")}>
            Differential (Old/New)
          </ModeButton>
          <ModeButton active={mode === "gitdiff"} onClick={() => setMode("gitdiff")}>
            Git Diff (@@ hunks)
          </ModeButton>
        </div>

        <div style={{ fontSize: 12, color: "#475569" }}>
          Scope: <strong>single function only</strong>. Called functions stay as simple nodes (no recursive expansion).
        </div>

        {mode === "js" && (
          <>
            <label style={labelStyle}>JavaScript Function</label>
            <textarea value={code} onChange={(e) => setCode(e.target.value)} style={textAreaStyle} />
          </>
        )}

        {mode === "diff" && (
          <>
            <label style={labelStyle}>Old Code</label>
            <textarea
              value={oldCode}
              onChange={(e) => setOldCode(e.target.value)}
              style={{ ...textAreaStyle, height: "30vh" }}
            />
            <label style={labelStyle}>New Code</label>
            <textarea
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              style={{ ...textAreaStyle, height: "30vh" }}
            />
          </>
        )}

        {mode === "gitdiff" && (
          <>
            <label style={labelStyle}>Unified Git Diff</label>
            <textarea
              value={gitDiff}
              onChange={(e) => setGitDiff(e.target.value)}
              style={{ ...textAreaStyle, height: "55vh" }}
            />
            <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.35 }}>
              Paste a standard unified diff (`git diff`) with `@@ -a,b +c,d @@` hunks.
              Best results when the diff includes the full function (or enough context to parse one function).
            </div>
          </>
        )}

        <button
          onClick={generate}
          style={{
            marginTop: 2,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #0f172a",
            background: "#0f172a",
            color: "#fff",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Generate Flowchart
        </button>

        {reconInfo && mode === "gitdiff" && (
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              color: "#334155",
            }}
          >
            <div>
              <strong>Parsed diff:</strong> {reconInfo.hunks} hunk(s)
            </div>
            <div>Old: {reconInfo.oldPath || "-"}</div>
            <div>New: {reconInfo.newPath || "-"}</div>
          </div>
        )}

        {error ? (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              whiteSpace: "pre-wrap",
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.4 }}>
          <div>
            <strong>Legend</strong>
          </div>
          <div>• Diamonds = conditions</div>
          <div>• Rectangles = statements/actions</div>
          <div>• Green = added code</div>
          <div>• Red strike = deleted code</div>
        </div>
      </div>

      <div style={{ height: "100%" }}>{flow}</div>
    </div>
  );
}

function ModeButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 10px",
        borderRadius: 8,
        border: "1px solid #94a3b8",
        background: active ? "#0f172a" : "#fff",
        color: active ? "#fff" : "#0f172a",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

const labelStyle = { fontSize: 12, fontWeight: 600 };

const textAreaStyle = {
  width: "100%",
  height: "65vh",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: 10,
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 12,
  resize: "vertical",
  lineHeight: 1.4,
};
```

```bash
# setup
npm create vite@latest js-diff-flow -- --template react
cd js-diff-flow
npm install
npm install reactflow dagre @babel/parser @babel/traverse
npm run dev
```
