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

const traverse = traverseModule.default || traverseModule;

// -------------------- UI node --------------------
const NODE_W = 300;
const NODE_H = 90;

function UmlLikeNode({ data }) {
  const { title, kind, subtitle, diff } = data;
  const isFile = kind === "file";

  const border = isFile ? "#0f172a" : "#94a3b8";

  return (
    <div
      style={{
        minWidth: NODE_W,
        minHeight: NODE_H,
        border: `1px solid ${border}`,
        borderRadius: 10,
        background: "#fff",
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
        fontSize: 12,
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid #e2e8f0",
          background: isFile ? "#f8fafc" : "#ffffff",
        }}
      >
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div style={{ color: "#64748b", fontSize: 11 }}>{subtitle}</div>
      </div>

      {diff ? (
        <div>
          {diff.deleted ? (
            <div
              style={{
                background: "#fecaca",
                color: "#7f1d1d",
                padding: "6px 8px",
                borderBottom: diff.added ? "1px solid #fca5a5" : "none",
                fontFamily: "ui-monospace, Menlo, monospace",
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
                padding: "6px 8px",
                fontFamily: "ui-monospace, Menlo, monospace",
                whiteSpace: "pre-wrap",
              }}
            >
              <span style={{ marginRight: 6, fontWeight: 700 }}>+</span>
              <strong>{diff.added}</strong>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ padding: "8px 10px", color: "#334155", whiteSpace: "pre-wrap" }}>
          {data.body || ""}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { umlNode: UmlLikeNode };

// -------------------- Dagre --------------------
function layoutGraph(nodes, edges, direction = "LR") {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    ranksep: 80,
    nodesep: 50,
    marginx: 20,
    marginy: 20,
  });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return {
    nodes: nodes.map((n) => {
      const p = g.node(n.id);
      return {
        ...n,
        position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
        sourcePosition: direction === "LR" ? Position.Right : Position.Bottom,
        targetPosition: direction === "LR" ? Position.Left : Position.Top,
      };
    }),
    edges,
  };
}

// -------------------- utils --------------------
let ID = 0;
const nextId = (p = "id") => `${p}_${++ID}`;

function rfNode({ title, kind, subtitle, body = "", diff = null }) {
  return {
    id: nextId("node"),
    type: "umlNode",
    data: { title, kind, subtitle, body, diff },
    position: { x: 0, y: 0 },
  };
}

function rfEdge(source, target, label = "") {
  return {
    id: nextId("edge"),
    source,
    target,
    label,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { strokeWidth: 1.4 },
    labelStyle: { fontSize: 11, fill: "#334155" },
  };
}

function normalizeSpace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function srcText(node, source) {
  if (!node || node.start == null || node.end == null) return "";
  return source.slice(node.start, node.end).trim();
}

// -------------------- JS file analyzer (top-level only) --------------------
function parseFileAst(code) {
  return parse(code, {
    sourceType: "module",
    plugins: [],
    ranges: true,
    errorRecovery: false,
  });
}

function getFunctionParamList(fnNode) {
  return (fnNode.params || [])
    .map((p) => (p.type === "Identifier" ? p.name : "arg"))
    .join(", ");
}

function collectTopLevelEntities(code) {
  const ast = parseFileAst(code);
  const entities = []; // imports, vars, functions
  const importsByLocal = new Map();
  const vars = new Map();
  const funcs = new Map();

  const body = ast.program.body || [];

  for (const stmt of body) {
    // import ... from ...
    if (stmt.type === "ImportDeclaration") {
      const source = stmt.source?.value || "";
      const names = (stmt.specifiers || []).map((s) => {
        const local = s.local?.name;
        const imported =
          s.type === "ImportDefaultSpecifier"
            ? "default"
            : s.type === "ImportNamespaceSpecifier"
            ? "*"
            : s.imported?.name || "unknown";
        if (local) importsByLocal.set(local, source);
        return `${imported} as ${local}`;
      });

      entities.push({
        kind: "import",
        name: source,
        key: `import:${source}`,
        signature: `import ${names.join(", ")} from "${source}"`,
        bodyText: normalizeSpace(srcText(stmt, code)),
        locText: normalizeSpace(srcText(stmt, code)),
      });
      continue;
    }

    // function foo() {}
    if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
      const name = stmt.id.name;
      const signature = `function ${name}(${getFunctionParamList(stmt)})`;
      const bodyText = normalizeSpace(srcText(stmt.body, code));
      const fnEntity = {
        kind: "function",
        name,
        key: `function:${name}`,
        signature,
        bodyText,
        locText: normalizeSpace(srcText(stmt, code)),
        node: stmt,
        calls: new Set(),
        usesVars: new Set(),
        usesImports: new Set(),
      };
      funcs.set(name, fnEntity);
      entities.push(fnEntity);
      continue;
    }

    // const x = ... / const f = () => {} / const f = function() {}
    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations || []) {
        if (!d.id || d.id.type !== "Identifier") continue;
        const name = d.id.name;
        const init = d.init;

        if (
          init &&
          (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")
        ) {
          const fakeFn = { ...init, id: d.id };
          const signature = `function ${name}(${getFunctionParamList(fakeFn)})`;
          const bodyText =
            init.body?.type === "BlockStatement"
              ? normalizeSpace(srcText(init.body, code))
              : normalizeSpace(srcText(init.body, code));
          const fnEntity = {
            kind: "function",
            name,
            key: `function:${name}`,
            signature,
            bodyText,
            locText: normalizeSpace(srcText(d, code)),
            node: fakeFn,
            calls: new Set(),
            usesVars: new Set(),
            usesImports: new Set(),
          };
          funcs.set(name, fnEntity);
          entities.push(fnEntity);
        } else {
          const signature = `var ${name}`;
          const bodyText = normalizeSpace(srcText(d, code));
          const vEntity = {
            kind: "variable",
            name,
            key: `variable:${name}`,
            signature,
            bodyText,
            locText: normalizeSpace(srcText(d, code)),
          };
          vars.set(name, vEntity);
          entities.push(vEntity);
        }
      }

      // CommonJS require capture: const x = require("...")
      for (const d of stmt.declarations || []) {
        if (
          d.id?.type === "Identifier" &&
          d.init?.type === "CallExpression" &&
          d.init.callee?.type === "Identifier" &&
          d.init.callee.name === "require" &&
          d.init.arguments?.[0]?.type === "StringLiteral"
        ) {
          importsByLocal.set(d.id.name, d.init.arguments[0].value);
          const src = d.init.arguments[0].value;
          if (!entities.find((e) => e.key === `import:${src}`)) {
            entities.push({
              kind: "import",
              name: src,
              key: `import:${src}`,
              signature: `require("${src}")`,
              bodyText: `require("${src}")`,
              locText: `require("${src}")`,
            });
          }
        }
      }
    }
  }

  // Analyze top-level function dependencies (calls + top-level var usage + imported usage)
  const topFuncNames = new Set([...funcs.keys()]);
  const topVarNames = new Set([...vars.keys()]);
  const importLocalNames = new Set([...importsByLocal.keys()]);

  for (const fn of funcs.values()) {
    traverse(
      parse(srcText(fn.node, code), {
        sourceType: "module",
        plugins: [],
        ranges: true,
      }),
      {
        CallExpression(path) {
          const c = path.node.callee;
          if (c.type === "Identifier" && topFuncNames.has(c.name)) {
            fn.calls.add(c.name);
          }
          if (c.type === "Identifier" && importLocalNames.has(c.name)) {
            fn.usesImports.add(c.name);
          }
          if (
            c.type === "MemberExpression" &&
            c.object?.type === "Identifier" &&
            importLocalNames.has(c.object.name)
          ) {
            fn.usesImports.add(c.object.name);
          }
        },
        Identifier(path) {
          // Skip declaration identifiers and params
          if (path.parent.type === "FunctionDeclaration" && path.parent.id === path.node) return;
          if (
            (path.parent.type === "VariableDeclarator" && path.parent.id === path.node) ||
            (path.parent.type === "FunctionExpression" && path.parent.id === path.node) ||
            (path.parent.type === "ArrowFunctionExpression") ||
            (path.parent.type === "FunctionDeclaration")
          ) {
            return;
          }

          const n = path.node.name;
          if (topVarNames.has(n)) fn.usesVars.add(n);
          if (importLocalNames.has(n)) fn.usesImports.add(n);
        },
      }
    );
  }

  return {
    entities,
    funcs,
    vars,
    importsByLocal,
    fileName: "current-file.js",
  };
}

// -------------------- diff model for file diagram --------------------
function buildEntityDiff(oldCode, newCode) {
  const oldA = collectTopLevelEntities(oldCode);
  const newA = collectTopLevelEntities(newCode);

  const oldMap = new Map(oldA.entities.map((e) => [e.key, e]));
  const newMap = new Map(newA.entities.map((e) => [e.key, e]));

  const diffByKey = new Map();
  const deletedOnly = [];

  for (const [key, oldE] of oldMap.entries()) {
    const newE = newMap.get(key);
    if (!newE) {
      deletedOnly.push(oldE);
      continue;
    }
    const oldSig = `${oldE.signature}\n${oldE.bodyText}`;
    const newSig = `${newE.signature}\n${newE.bodyText}`;
    if (oldSig !== newSig) {
      diffByKey.set(key, {
        deleted: oldE.locText || oldE.bodyText || oldE.signature,
        added: newE.locText || newE.bodyText || newE.signature,
      });
    }
  }

  for (const [key, newE] of newMap.entries()) {
    if (!oldMap.has(key)) {
      diffByKey.set(key, {
        added: newE.locText || newE.bodyText || newE.signature,
      });
    }
  }

  return {
    newAnalysis: newA,
    diffByKey,
    deletedOnly,
  };
}

// -------------------- graph builder --------------------
function buildFileDiagram({ code, oldCode = null, fileName = "file.js" }) {
  ID = 0;
  const nodes = [];
  const edges = [];

  let analysis;
  let diffByKey = new Map();
  let deletedOnly = [];

  if (oldCode != null) {
    const diff = buildEntityDiff(oldCode, code);
    analysis = diff.newAnalysis;
    diffByKey = diff.diffByKey;
    deletedOnly = diff.deletedOnly;
  } else {
    analysis = collectTopLevelEntities(code);
  }

  const fileNode = rfNode({
    title: fileName,
    kind: "file",
    subtitle: "«file diagram» top-level dependencies",
    body: "Imports / Variables / Functions",
  });
  nodes.push(fileNode);

  const nodeIdByEntityKey = new Map();

  // imports, vars, funcs as separate nodes
  for (const e of analysis.entities) {
    const subtitle =
      e.kind === "import"
        ? "«import»"
        : e.kind === "variable"
        ? "«variable»"
        : "«function»";

    const body =
      e.kind === "function"
        ? e.signature
        : e.kind === "variable"
        ? e.bodyText
        : e.signature;

    const n = rfNode({
      title: e.name,
      kind: e.kind,
      subtitle,
      body,
      diff: diffByKey.get(e.key) || null,
    });

    nodes.push(n);
    nodeIdByEntityKey.set(e.key, n.id);

    // containment edge from file node
    edges.push(rfEdge(fileNode.id, n.id, "contains"));
  }

  // deleted-only ghost nodes
  for (const e of deletedOnly) {
    const n = rfNode({
      title: `${e.name} (deleted)`,
      kind: e.kind,
      subtitle: `«${e.kind}»`,
      diff: { deleted: e.locText || e.bodyText || e.signature },
    });
    nodes.push(n);
    edges.push(rfEdge(fileNode.id, n.id, "deleted"));
  }

  // dependency edges from functions -> vars/functions/imports
  for (const fn of analysis.funcs.values()) {
    const fnId = nodeIdByEntityKey.get(fn.key);
    if (!fnId) continue;

    for (const calleeName of fn.calls) {
      const toId = nodeIdByEntityKey.get(`function:${calleeName}`);
      if (toId && toId !== fnId) edges.push(rfEdge(fnId, toId, "calls"));
    }

    for (const v of fn.usesVars) {
      const toId = nodeIdByEntityKey.get(`variable:${v}`);
      if (toId) edges.push(rfEdge(fnId, toId, "uses"));
    }

    for (const localImport of fn.usesImports) {
      // Map local import alias -> source node by source string
      const source = analysis.importsByLocal.get(localImport);
      if (!source) continue;
      const toId = nodeIdByEntityKey.get(`import:${source}`);
      if (toId) edges.push(rfEdge(fnId, toId, "depends"));
    }
  }

  return layoutGraph(nodes, dedupeEdges(edges), "LR");
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const k = `${e.source}|${e.target}|${e.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// -------------------- unified diff parser / reconstructor --------------------
function parseUnifiedDiff(diffText) {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let currentFile = null;
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (currentFile) files.push(currentFile);
      currentFile = { oldPath: line.slice(4).trim(), newPath: null, hunks: [] };
      currentHunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!currentFile) currentFile = { oldPath: null, newPath: null, hunks: [] };
      currentFile.newPath = line.slice(4).trim();
      continue;
    }

    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      if (!currentFile) currentFile = { oldPath: null, newPath: null, hunks: [] };
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

    if (currentHunk) currentHunk.lines.push(line);
  }

  if (currentFile) files.push(currentFile);
  return files;
}

function reconstructFromUnifiedDiff(diffText) {
  const files = parseUnifiedDiff(diffText);
  const file = files.find((f) => f.hunks.length > 0);
  if (!file) throw new Error("No @@ unified diff hunk found.");

  const oldLines = [];
  const newLines = [];

  for (const h of file.hunks) {
    for (const raw of h.lines) {
      if (raw.startsWith("\\ No newline")) continue;
      if (raw.startsWith("+")) newLines.push(raw.slice(1));
      else if (raw.startsWith("-")) oldLines.push(raw.slice(1));
      else if (raw.startsWith(" ")) {
        const c = raw.slice(1);
        oldLines.push(c);
        newLines.push(c);
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

// -------------------- samples --------------------
const SAMPLE_NEW = `import http from "http";
const config = { retries: 3 };
const baseUrl = "https://api.example.com";

function buildUrl(path) {
  return baseUrl + path;
}

function fetchUsers() {
  const url = buildUrl("/users");
  return http.get(url);
}

const logUsers = () => {
  console.log(config.retries);
  return fetchUsers();
};`;

const SAMPLE_OLD = `import http from "http";
const config = { retries: 2 };
const baseUrl = "https://api.example.com";

function buildUrl(path) {
  return baseUrl + path;
}

function fetchUsers() {
  const url = buildUrl("/users");
  return http.get(url);
}

const logUsers = () => {
  console.log(config.retries);
  return fetchUsers();
};`;

const SAMPLE_GIT_DIFF = `diff --git a/api.js b/api.js
index 1111111..2222222 100644
--- a/api.js
+++ b/api.js
@@ -1,4 +1,4 @@
 import http from "http";
-const config = { retries: 2 };
+const config = { retries: 3 };
 const baseUrl = "https://api.example.com";

@@ -10,6 +10,10 @@ function fetchUsers() {
   return http.get(url);
 }

+function ping() {
+  return http.get(buildUrl("/ping"));
+}
+
 const logUsers = () => {
   console.log(config.retries);
   return fetchUsers();`;

// -------------------- app --------------------
export default function App() {
  const [mode, setMode] = useState("gitdiff"); // js | diff | gitdiff
  const [code, setCode] = useState(SAMPLE_NEW);
  const [oldCode, setOldCode] = useState(SAMPLE_OLD);
  const [newCode, setNewCode] = useState(SAMPLE_NEW);
  const [gitDiff, setGitDiff] = useState(SAMPLE_GIT_DIFF);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState(null);

  const generate = useCallback(() => {
    try {
      setError("");
      setMeta(null);

      if (mode === "js") {
        const g = buildFileDiagram({ code, fileName: "input.js" });
        setNodes(g.nodes);
        setEdges(g.edges);
        return;
      }

      if (mode === "diff") {
        const g = buildFileDiagram({ code: newCode, oldCode, fileName: "diff-file.js" });
        setNodes(g.nodes);
        setEdges(g.edges);
        return;
      }

      const { oldCode: o, newCode: n, meta: m } = reconstructFromUnifiedDiff(gitDiff);
      setMeta(m);

      const fileName =
        (m.newPath || m.oldPath || "diff-file.js").replace(/^a\//, "").replace(/^b\//, "");
      const g = buildFileDiagram({ code: n, oldCode: o, fileName });
      setNodes(g.nodes);
      setEdges(g.edges);
    } catch (e) {
      setError(e.message || "Failed to generate file diagram.");
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
    <div style={{ height: "100vh", display: "grid", gridTemplateColumns: "520px 1fr" }}>
      <div
        style={{
          borderRight: "1px solid #e2e8f0",
          padding: 14,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>
          JS File Diagram (UML-style) + Differential
        </h2>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ModeBtn active={mode === "js"} onClick={() => setMode("js")}>
            JS File
          </ModeBtn>
          <ModeBtn active={mode === "diff"} onClick={() => setMode("diff")}>
            Old/New Diff
          </ModeBtn>
          <ModeBtn active={mode === "gitdiff"} onClick={() => setMode("gitdiff")}>
            Git Diff (@@)
          </ModeBtn>
        </div>

        <div style={{ fontSize: 12, color: "#475569" }}>
          Shows <strong>top-level</strong> imports, variables, function declarations (including
          function expressions assigned to variables), and dependencies inside the file.
        </div>

        {mode === "js" && (
          <>
            <label style={labelStyle}>JavaScript File</label>
            <textarea style={taStyle} value={code} onChange={(e) => setCode(e.target.value)} />
          </>
        )}

        {mode === "diff" && (
          <>
            <label style={labelStyle}>Old File</label>
            <textarea
              style={{ ...taStyle, height: "28vh" }}
              value={oldCode}
              onChange={(e) => setOldCode(e.target.value)}
            />
            <label style={labelStyle}>New File</label>
            <textarea
              style={{ ...taStyle, height: "28vh" }}
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
            />
          </>
        )}

        {mode === "gitdiff" && (
          <>
            <label style={labelStyle}>Unified Git Diff</label>
            <textarea
              style={{ ...taStyle, height: "52vh" }}
              value={gitDiff}
              onChange={(e) => setGitDiff(e.target.value)}
            />
            <div style={{ fontSize: 11, color: "#64748b" }}>
              Paste standard `git diff` unified hunks. Best when the patch includes enough context
              to reconstruct a parseable file region.
            </div>
          </>
        )}

        <button
          onClick={generate}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #0f172a",
            background: "#0f172a",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Generate File Diagram
        </button>

        {meta && mode === "gitdiff" && (
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
              <strong>Parsed diff:</strong> {meta.hunks} hunk(s)
            </div>
            <div>Old: {meta.oldPath || "-"}</div>
            <div>New: {meta.newPath || "-"}</div>
          </div>
        )}

        {error && (
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
        )}

        <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>
          <div>
            <strong>Legend</strong>
          </div>
          <div>• File → contains imports/variables/functions</div>
          <div>• Function → calls function / uses variable / depends on import</div>
          <div>• Green = added, Red strike = deleted (differential nodes)</div>
        </div>
      </div>

      <div style={{ height: "100%" }}>{flow}</div>
    </div>
  );
}

function ModeBtn({ active, onClick, children }) {
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
const taStyle = {
  width: "100%",
  height: "60vh",
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
npm create vite@latest js-file-diagram -- --template react
cd js-file-diagram
npm install
npm install reactflow dagre @babel/parser @babel/traverse
npm run dev
```

A couple of practical notes:

* This is a **UML-style file diagram** (not true OOP class modeling), tailored for JavaScript files.
* It intentionally stays **top-level only** (imports, file-level vars, function declarations/assigned functions).
* Unified diff mode works when the patch includes enough context to reconstruct parseable code; otherwise use **Old/New** mode.
