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

// ======================================================
// JS API Sequence Diagram (UML-style) + Differential
// - Participants: file-level objects / external systems
// - Messages: function-level calls (API handlers / functions)
// - Diff overlay: green added / red deleted
// ======================================================

// ---------- UI ----------
const NODE_W = 270;
const NODE_H = 88;

function ParticipantNode({ data }) {
  const { title, kind, subtitle, body, diff } = data;
  const isRoot = kind === "file";
  return (
    <div
      style={{
        minWidth: NODE_W,
        minHeight: NODE_H,
        border: `1px solid ${isRoot ? "#0f172a" : "#94a3b8"}`,
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
          background: isRoot ? "#f8fafc" : "#fff",
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
          {body}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { pNode: ParticipantNode };

// ---------- Dagre ----------
function layoutGraph(nodes, edges, direction = "LR") {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    ranksep: 90,
    nodesep: 60,
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

// ---------- Common helpers ----------
let ID = 0;
const nextId = (p = "id") => `${p}_${++ID}`;

function rfNode({ title, kind, subtitle, body = "", diff = null }) {
  return {
    id: nextId("node"),
    type: "pNode",
    data: { title, kind, subtitle, body, diff },
    position: { x: 0, y: 0 },
  };
}

function rfEdge(source, target, label = "", styleKind = "normal") {
  const styleMap = {
    normal: { stroke: "#475569", strokeWidth: 1.5 },
    added: { stroke: "#16a34a", strokeWidth: 2 },
    deleted: { stroke: "#dc2626", strokeWidth: 2, strokeDasharray: "6 4" },
    changed: { stroke: "#0f172a", strokeWidth: 2 },
  };

  return {
    id: nextId("edge"),
    source,
    target,
    label,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: styleMap[styleKind] || styleMap.normal,
    labelStyle: {
      fontSize: 11,
      fill:
        styleKind === "added"
          ? "#166534"
          : styleKind === "deleted"
          ? "#991b1b"
          : "#334155",
      fontWeight: styleKind === "normal" ? 400 : 700,
      background: "#fff",
    },
  };
}

function normalizeSpace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function srcText(node, source) {
  if (!node || node.start == null || node.end == null) return "";
  return source.slice(node.start, node.end).trim();
}

// ---------- Parse / analyze JS API file ----------
function parseFileAst(code) {
  return parse(code, {
    sourceType: "module",
    plugins: [],
    ranges: true,
    errorRecovery: false,
  });
}

// Detect "external systems" from imports/requires and known identifiers
function classifyExternalSystem(nameOrPath) {
  const v = (nameOrPath || "").toLowerCase();

  // DB
  if (
    ["mongoose", "sequelize", "prisma", "typeorm", "knex", "pg", "mysql", "mongodb"].some((k) =>
      v.includes(k)
    )
  ) {
    return "database";
  }

  // Cache
  if (["redis", "ioredis", "memcached", "valkey"].some((k) => v.includes(k))) {
    return "cache";
  }

  // Storage
  if (
    ["s3", "gcs", "storage", "bucket", "minio", "blob", "azure/storage"].some((k) =>
      v.includes(k)
    )
  ) {
    return "storage";
  }

  // HTTP / external services
  if (
    ["axios", "fetch", "got", "request", "grpc", "amqplib", "kafka", "sns", "sqs"].some((k) =>
      v.includes(k)
    )
  ) {
    return "service";
  }

  // Frameworks / routers / local modules default
  return "module";
}

function isApiHandlerName(name) {
  return /(handler|route|controller|api|get|post|put|patch|delete|create|update|list|fetch)/i.test(
    name || ""
  );
}

function methodNameFromMemberExpression(member, source) {
  if (!member || member.type !== "MemberExpression") return "";
  if (member.property?.type === "Identifier") return member.property.name;
  if (member.property?.type === "StringLiteral") return member.property.value;
  return normalizeSpace(srcText(member.property, source));
}

// Build top-level symbols and function registry
function collectTopLevelFileModel(code) {
  const ast = parseFileAst(code);
  const body = ast.program.body || [];

  const importsByLocal = new Map(); // local -> source path
  const topVars = new Map(); // name -> declarator text
  const functions = new Map(); // fn name -> entity
  const participantAliases = new Map(); // local alias -> participant key

  const imports = []; // participant candidates
  const participants = []; // normalized participants list

  for (const stmt of body) {
    if (stmt.type === "ImportDeclaration") {
      const sourcePath = stmt.source?.value || "";
      const kind = classifyExternalSystem(sourcePath);
      const specs = stmt.specifiers || [];
      for (const s of specs) {
        const local = s.local?.name;
        if (local) importsByLocal.set(local, sourcePath);
      }
      const key = `participant:import:${sourcePath}`;
      if (!participants.find((p) => p.key === key)) {
        participants.push({
          key,
          name: sourcePath,
          kind,
          signature: normalizeSpace(srcText(stmt, code)),
          raw: normalizeSpace(srcText(stmt, code)),
        });
      }
      imports.push(sourcePath);
      continue;
    }

    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations || []) {
        if (d.id?.type !== "Identifier") continue;
        const name = d.id.name;

        // function assigned to variable
        if (
          d.init &&
          (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression")
        ) {
          const fnNode = { ...d.init, id: d.id };
          const fnEntity = {
            key: `function:${name}`,
            name,
            node: fnNode,
            signature: `function ${name}(${(fnNode.params || [])
              .map((p) => (p.type === "Identifier" ? p.name : "arg"))
              .join(", ")})`,
            raw: normalizeSpace(srcText(d, code)),
            calls: [],
          };
          functions.set(name, fnEntity);
        } else {
          const vText = normalizeSpace(srcText(d, code));
          topVars.set(name, { name, raw: vText });

          // CommonJS require
          if (
            d.init?.type === "CallExpression" &&
            d.init.callee?.type === "Identifier" &&
            d.init.callee.name === "require" &&
            d.init.arguments?.[0]?.type === "StringLiteral"
          ) {
            const reqPath = d.init.arguments[0].value;
            importsByLocal.set(name, reqPath);
            const key = `participant:import:${reqPath}`;
            if (!participants.find((p) => p.key === key)) {
              participants.push({
                key,
                name: reqPath,
                kind: classifyExternalSystem(reqPath),
                signature: `require("${reqPath}")`,
                raw: `const ${name} = require("${reqPath}")`,
              });
            }
          }

          // Heuristic external clients defined in-file (db, redis, s3, etc)
          const lname = name.toLowerCase();
          if (
            /(db|database|repo|redis|cache|client|s3|bucket|storage|queue|producer|consumer)/.test(
              lname
            )
          ) {
            const kind = lname.includes("redis") || lname.includes("cache")
              ? "cache"
              : lname.includes("s3") || lname.includes("bucket") || lname.includes("storage")
              ? "storage"
              : lname.includes("db") || lname.includes("repo") || lname.includes("database")
              ? "database"
              : "service";

            const key = `participant:var:${name}`;
            if (!participants.find((p) => p.key === key)) {
              participants.push({
                key,
                name,
                kind,
                signature: vText,
                raw: vText,
              });
              participantAliases.set(name, key);
            }
          }
        }
      }
      continue;
    }

    if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
      const name = stmt.id.name;
      const fnEntity = {
        key: `function:${name}`,
        name,
        node: stmt,
        signature: `function ${name}(${(stmt.params || [])
          .map((p) => (p.type === "Identifier" ? p.name : "arg"))
          .join(", ")})`,
        raw: normalizeSpace(srcText(stmt, code)),
        calls: [],
      };
      functions.set(name, fnEntity);
      continue;
    }
  }

  // imported aliases become participant aliases
  for (const [local, sourcePath] of importsByLocal.entries()) {
    participantAliases.set(local, `participant:import:${sourcePath}`);
  }

  // analyze function-level messages
  const topFunctionNames = new Set([...functions.keys()]);
  const topVarNames = new Set([...topVars.keys()]);

  for (const fn of functions.values()) {
    const fnSource = srcText(fn.node, code);
    const fnAst = parse(fnSource, {
      sourceType: "module",
      plugins: [],
      ranges: true,
    });

    const messages = [];
    traverse(fnAst, {
      CallExpression(path) {
        const n = path.node;
        const callText = normalizeSpace(srcText(n, fnSource));
        const callee = n.callee;

        // 1) direct top-level function call => internal message
        if (callee.type === "Identifier" && topFunctionNames.has(callee.name)) {
          messages.push({
            from: fn.name,
            to: callee.name,
            label: `${callee.name}()`,
            raw: callText,
            category: "internal",
          });
          return;
        }

        // 2) imported alias direct call => external participant
        if (callee.type === "Identifier" && participantAliases.has(callee.name)) {
          const pKey = participantAliases.get(callee.name);
          messages.push({
            from: fn.name,
            toParticipantKey: pKey,
            label: `${callee.name}()`,
            raw: callText,
            category: "external",
          });
          return;
        }

        // 3) member calls: x.y() ; axios.get() ; db.query() ; redis.get() etc
        if (callee.type === "MemberExpression") {
          const obj = callee.object;
          const method = methodNameFromMemberExpression(callee, fnSource);

          // object is top-level function? not common, skip
          if (obj?.type === "Identifier") {
            const objName = obj.name;

            // imported/local participant alias
            if (participantAliases.has(objName)) {
              messages.push({
                from: fn.name,
                toParticipantKey: participantAliases.get(objName),
                label: `${objName}.${method}()`,
                raw: callText,
                category: "external",
              });
              return;
            }

            // top-level vars that look like external client
            if (topVarNames.has(objName)) {
              const lname = objName.toLowerCase();
              if (
                /(db|database|repo|redis|cache|client|s3|bucket|storage|queue|producer|consumer)/.test(
                  lname
                )
              ) {
                const pKey = participantAliases.get(objName) || `participant:var:${objName}`;
                participantAliases.set(objName, pKey);
                messages.push({
                  from: fn.name,
                  toParticipantKey: pKey,
                  label: `${objName}.${method}()`,
                  raw: callText,
                  category: "external",
                });
                return;
              }
            }
          }

          // nested style: this.service.do() / ctx.db.query()
          if (obj?.type === "MemberExpression" && obj.object?.type === "Identifier") {
            const root = obj.object.name;
            const mid = methodNameFromMemberExpression(obj, fnSource);
            const pseudoName = `${root}.${mid}`;
            const pseudoKey = `participant:pseudo:${pseudoName}`;
            messages.push({
              from: fn.name,
              toParticipantKey: pseudoKey,
              label: `${pseudoName}.${method}()`,
              raw: callText,
              category: "external",
              pseudoKind: /(db|repo)/i.test(pseudoName)
                ? "database"
                : /(redis|cache)/i.test(pseudoName)
                ? "cache"
                : /(s3|storage|bucket)/i.test(pseudoName)
                ? "storage"
                : "service",
              pseudoName,
            });
            return;
          }
        }

        // 4) fetch("http...") special case
        if (
          callee.type === "Identifier" &&
          callee.name === "fetch" &&
          n.arguments?.length
        ) {
          const a0 = n.arguments[0];
          const argText = normalizeSpace(srcText(a0, fnSource));
          const pKey = "participant:external:http";
          messages.push({
            from: fn.name,
            toParticipantKey: pKey,
            label: `fetch(${argText})`,
            raw: callText,
            category: "external",
            pseudoKind: "service",
            pseudoName: "external-http",
          });
        }
      },
    });

    fn.calls = messages;
  }

  // choose API entry functions (handlers/controllers/routes)
  const entryFunctions = [...functions.values()].filter((f) => isApiHandlerName(f.name));
  const chosenEntries = entryFunctions.length ? entryFunctions : [...functions.values()].slice(0, 5);

  return {
    code,
    functions,
    topVars,
    participants,
    participantAliases,
    chosenEntries,
  };
}

// ---------- Sequence messages flatten (one-level) ----------
function buildSequenceMessages(model) {
  const participants = [...model.participants];
  const participantKeys = new Set(participants.map((p) => p.key));
  const pseudoParticipants = new Map();

  // Internal function participants (API functions only + targets they call)
  const internalFunctions = new Map();
  for (const fn of model.chosenEntries) internalFunctions.set(fn.name, fn);

  // Expand one hop internal calls (still file-level function participants)
  for (const fn of model.chosenEntries) {
    for (const msg of fn.calls) {
      if (msg.to && model.functions.has(msg.to)) {
        internalFunctions.set(msg.to, model.functions.get(msg.to));
      }
    }
  }

  const messages = [];

  for (const fn of model.chosenEntries) {
    // inbound message from "API Client"
    messages.push({
      fromSpecial: "client",
      toFn: fn.name,
      label: `${fn.name}()`,
      raw: fn.signature,
      styleKind: "normal",
      key: `inbound:${fn.name}`,
    });

    // function-level calls
    for (const c of fn.calls) {
      if (c.to && internalFunctions.has(c.to)) {
        messages.push({
          fromFn: fn.name,
          toFn: c.to,
          label: c.label,
          raw: c.raw,
          styleKind: "normal",
          key: `call:${fn.name}->${c.to}:${c.label}`,
        });
      } else if (c.toParticipantKey) {
        let pKey = c.toParticipantKey;
        if (!participantKeys.has(pKey) && c.pseudoName) {
          if (!pseudoParticipants.has(pKey)) {
            pseudoParticipants.set(pKey, {
              key: pKey,
              name: c.pseudoName,
              kind: c.pseudoKind || "service",
              signature: c.pseudoName,
              raw: c.pseudoName,
            });
          }
        }
        messages.push({
          fromFn: fn.name,
          toParticipantKey: pKey,
          label: c.label,
          raw: c.raw,
          styleKind: "normal",
          key: `ext:${fn.name}->${pKey}:${c.label}`,
        });
      }
    }
  }

  return {
    participants: participants.concat([...pseudoParticipants.values()]),
    internalFunctions: [...internalFunctions.values()],
    messages,
  };
}

// ---------- Diffing for sequence (participants + messages) ----------
function keyByNormalizedMessage(msg) {
  const normLabel = (msg.label || "")
    .replace(/\b\d+(\.\d+)?\b/g, "#")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"STR"');
  const from = msg.fromSpecial || msg.fromFn || "";
  const to = msg.toFn || msg.toParticipantKey || "";
  return `${from}|${to}|${normLabel}`;
}

function buildSequenceDiff(oldCode, newCode) {
  const oldModel = collectTopLevelFileModel(oldCode);
  const newModel = collectTopLevelFileModel(newCode);

  const oldSeq = buildSequenceMessages(oldModel);
  const newSeq = buildSequenceMessages(newModel);

  // Participant diffs
  const oldP = new Map(
    [
      { key: "participant:special:client", name: "API Client", kind: "client", raw: "API Client" },
      ...oldSeq.participants,
      ...oldSeq.internalFunctions.map((f) => ({
        key: `participant:function:${f.name}`,
        name: f.name,
        kind: "function",
        raw: f.signature,
      })),
    ].map((p) => [p.key, p])
  );

  const newP = new Map(
    [
      { key: "participant:special:client", name: "API Client", kind: "client", raw: "API Client" },
      ...newSeq.participants,
      ...newSeq.internalFunctions.map((f) => ({
        key: `participant:function:${f.name}`,
        name: f.name,
        kind: "function",
        raw: f.signature,
      })),
    ].map((p) => [p.key, p])
  );

  const participantDiff = new Map();
  const deletedParticipants = [];

  for (const [k, op] of oldP.entries()) {
    const np = newP.get(k);
    if (!np) {
      if (k !== "participant:special:client") deletedParticipants.push(op);
      continue;
    }
    if (normalizeSpace(op.raw) !== normalizeSpace(np.raw)) {
      participantDiff.set(k, { deleted: op.raw, added: np.raw });
    }
  }
  for (const [k, np] of newP.entries()) {
    if (!oldP.has(k) && k !== "participant:special:client") {
      participantDiff.set(k, { added: np.raw });
    }
  }

  // Message diffs
  const oldMsgs = oldSeq.messages;
  const newMsgs = newSeq.messages;

  const oldSet = new Set(oldMsgs.map((m) => m.key));
  const newSet = new Set(newMsgs.map((m) => m.key));

  const oldByNorm = new Map();
  for (const m of oldMsgs) {
    if (newSet.has(m.key)) continue;
    const k = keyByNormalizedMessage(m);
    if (!oldByNorm.has(k)) oldByNorm.set(k, []);
    oldByNorm.get(k).push(m);
  }

  const msgStyleByKey = new Map();
  const msgLabelDiffByKey = new Map();
  const deletedMessages = [];

  // unchanged / changed / added
  for (const m of newMsgs) {
    if (oldSet.has(m.key)) {
      msgStyleByKey.set(m.key, "normal");
      continue;
    }

    const nk = keyByNormalizedMessage(m);
    const bucket = oldByNorm.get(nk);
    if (bucket && bucket.length) {
      const oldM = bucket.shift();
      msgStyleByKey.set(m.key, "changed");
      msgLabelDiffByKey.set(m.key, {
        deleted: oldM.label,
        added: m.label,
      });
    } else {
      msgStyleByKey.set(m.key, "added");
    }
  }

  // deleted-only messages (remain in oldByNorm or old not matched)
  for (const m of oldMsgs) {
    if (newSet.has(m.key)) continue;

    // if consumed by "changed", skip
    const wasConsumedAsChanged = [...msgLabelDiffByKey.values()].some((d) => d.deleted === m.label);
    // keep simple heuristic by exact same deleted label + route
    let consumed = false;
    for (const [newKey, d] of msgLabelDiffByKey.entries()) {
      const oldMsgFromNewNorm = d.deleted;
      if (oldMsgFromNewNorm === m.label) {
        consumed = true;
        break;
      }
    }
    if (!consumed && !wasConsumedAsChanged) {
      deletedMessages.push(m);
    }
  }

  return {
    newSeq,
    participantDiff,
    deletedParticipants,
    msgStyleByKey,
    msgLabelDiffByKey,
    deletedMessages,
  };
}

// ---------- Diagram builder ----------
function participantTitleAndSubtitle(p) {
  if (p.key === "participant:special:client") {
    return { title: "API Client", subtitle: "«actor»" };
  }
  if (p.key.startsWith("participant:function:")) {
    return { title: p.name, subtitle: "«handler/function»" };
  }

  const map = {
    database: "«database»",
    cache: "«cache»",
    storage: "«storage»",
    service: "«service»",
    module: "«module»",
    client: "«actor»",
    function: "«handler/function»",
  };
  return { title: p.name, subtitle: map[p.kind] || "«participant»" };
}

function buildSequenceDiagram({ code, oldCode = null, fileName = "api.js" }) {
  ID = 0;

  const nodes = [];
  const edges = [];

  let seq;
  let participantDiff = new Map();
  let deletedParticipants = [];
  let msgStyleByKey = new Map();
  let msgLabelDiffByKey = new Map();
  let deletedMessages = [];

  if (oldCode != null) {
    const d = buildSequenceDiff(oldCode, code);
    seq = d.newSeq;
    participantDiff = d.participantDiff;
    deletedParticipants = d.deletedParticipants;
    msgStyleByKey = d.msgStyleByKey;
    msgLabelDiffByKey = d.msgLabelDiffByKey;
    deletedMessages = d.deletedMessages;
  } else {
    const model = collectTopLevelFileModel(code);
    seq = buildSequenceMessages(model);
  }

  const fileNode = rfNode({
    title: fileName,
    kind: "file",
    subtitle: "«API sequence view» file-level participants",
    body: "Handlers + external systems + function messages",
  });
  nodes.push(fileNode);

  const pNodeByKey = new Map();

  // Add API Client first
  const clientP = { key: "participant:special:client", name: "API Client", kind: "client", raw: "API Client" };
  const clientMeta = participantTitleAndSubtitle(clientP);
  const clientNode = rfNode({
    title: clientMeta.title,
    kind: "participant",
    subtitle: clientMeta.subtitle,
    body: "Inbound requests",
    diff: participantDiff.get(clientP.key) || null,
  });
  nodes.push(clientNode);
  pNodeByKey.set(clientP.key, clientNode.id);
  edges.push(rfEdge(fileNode.id, clientNode.id, "participant"));

  // Internal function participants
  for (const f of seq.internalFunctions) {
    const p = {
      key: `participant:function:${f.name}`,
      name: f.name,
      kind: "function",
      raw: f.signature,
    };
    const meta = participantTitleAndSubtitle(p);
    const n = rfNode({
      title: meta.title,
      kind: "participant",
      subtitle: meta.subtitle,
      body: f.signature,
      diff: participantDiff.get(p.key) || null,
    });
    nodes.push(n);
    pNodeByKey.set(p.key, n.id);
    edges.push(rfEdge(fileNode.id, n.id, "participant"));
  }

  // External participants
  for (const p of seq.participants) {
    const meta = participantTitleAndSubtitle(p);
    const n = rfNode({
      title: meta.title,
      kind: "participant",
      subtitle: meta.subtitle,
      body: p.signature || p.raw || p.name,
      diff: participantDiff.get(p.key) || null,
    });
    nodes.push(n);
    pNodeByKey.set(p.key, n.id);
    edges.push(rfEdge(fileNode.id, n.id, "participant"));
  }

  // Deleted-only participant ghost nodes
  for (const p of deletedParticipants) {
    const meta = participantTitleAndSubtitle(p);
    const n = rfNode({
      title: `${meta.title} (deleted)`,
      kind: "participant",
      subtitle: meta.subtitle,
      diff: { deleted: p.raw || p.signature || p.name },
    });
    nodes.push(n);
    edges.push(rfEdge(fileNode.id, n.id, "deleted-participant", "deleted"));
  }

  // Message edges
  for (const m of seq.messages) {
    const fromKey = m.fromSpecial
      ? "participant:special:client"
      : `participant:function:${m.fromFn}`;
    const toKey = m.toFn ? `participant:function:${m.toFn}` : m.toParticipantKey;

    const s = pNodeByKey.get(fromKey);
    const t = pNodeByKey.get(toKey);
    if (!s || !t) continue;

    const styleKind = msgStyleByKey.get(m.key) || "normal";
    const diffLabel = msgLabelDiffByKey.get(m.key);

    let label = m.label;
    if (diffLabel) {
      label = `- ${diffLabel.deleted}\n+ ${diffLabel.added}`;
    } else if (styleKind === "added") {
      label = `+ ${m.label}`;
    }

    edges.push(rfEdge(s, t, label, styleKind));
  }

  // Deleted-only message edges (render dashed red, may point to ghost nodes if participants gone)
  for (const m of deletedMessages) {
    const fromKey = m.fromSpecial
      ? "participant:special:client"
      : `participant:function:${m.fromFn}`;
    const toKey = m.toFn ? `participant:function:${m.toFn}` : m.toParticipantKey;
    const s = pNodeByKey.get(fromKey);
    const t = pNodeByKey.get(toKey);
    if (!s || !t) continue;
    edges.push(rfEdge(s, t, `- ${m.label}`, "deleted"));
  }

  return layoutGraph(nodes, dedupeEdges(edges), "LR");
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const k = `${e.source}|${e.target}|${e.label}|${e.style?.stroke}|${e.style?.strokeDasharray || ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// ---------- Unified diff parser / reconstructor ----------
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

// ---------- Samples ----------
const SAMPLE_NEW = `import express from "express";
import axios from "axios";
import redis from "redis";
import { Pool } from "pg";
import { uploadToS3 } from "./storage";

const router = express.Router();
const db = new Pool();
const cache = redis.createClient();

function buildUserResponse(row) {
  return { id: row.id, name: row.name };
}

async function getUserHandler(req, res) {
  const cached = await cache.get("user:" + req.params.id);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  const result = await db.query("select * from users where id=$1", [req.params.id]);
  const profile = await axios.get("http://profile-svc/users/" + req.params.id);
  const payload = buildUserResponse(result.rows[0]);
  await cache.set("user:" + req.params.id, JSON.stringify(payload));
  await uploadToS3("audit/user-" + req.params.id + ".json", JSON.stringify(profile.data));
  return res.json(payload);
}

router.get("/users/:id", getUserHandler);`;

const SAMPLE_OLD = `import express from "express";
import axios from "axios";
import redis from "redis";
import { Pool } from "pg";

const router = express.Router();
const db = new Pool();
const cache = redis.createClient();

function buildUserResponse(row) {
  return { id: row.id, name: row.name };
}

async function getUserHandler(req, res) {
  const cached = await cache.get("user:" + req.params.id);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  const result = await db.query("select * from users where id=$1", [req.params.id]);
  const profile = await axios.get("http://profile-svc/users/" + req.params.id);
  const payload = buildUserResponse(result.rows[0]);
  await cache.set("user:" + req.params.id, JSON.stringify(payload));
  return res.json(payload);
}

router.get("/users/:id", getUserHandler);`;

const SAMPLE_GIT_DIFF = `diff --git a/userApi.js b/userApi.js
index 1111111..2222222 100644
--- a/userApi.js
+++ b/userApi.js
@@ -2,10 +2,11 @@
 import axios from "axios";
 import redis from "redis";
 import { Pool } from "pg";
+import { uploadToS3 } from "./storage";

 const router = express.Router();
 const db = new Pool();
 const cache = redis.createClient();
@@ -18,6 +19,7 @@ async function getUserHandler(req, res) {
   const profile = await axios.get("http://profile-svc/users/" + req.params.id);
   const payload = buildUserResponse(result.rows[0]);
   await cache.set("user:" + req.params.id, JSON.stringify(payload));
+  await uploadToS3("audit/user-" + req.params.id + ".json", JSON.stringify(profile.data));
   return res.json(payload);
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
  const [meta, setMeta] = useState(null);

  const generate = useCallback(() => {
    try {
      setError("");
      setMeta(null);

      if (mode === "js") {
        const g = buildSequenceDiagram({ code, fileName: "api.js" });
        setNodes(g.nodes);
        setEdges(g.edges);
        return;
      }

      if (mode === "diff") {
        const g = buildSequenceDiagram({ code: newCode, oldCode, fileName: "api.js" });
        setNodes(g.nodes);
        setEdges(g.edges);
        return;
      }

      const { oldCode: o, newCode: n, meta: m } = reconstructFromUnifiedDiff(gitDiff);
      setMeta(m);
      const fileName =
        (m.newPath || m.oldPath || "api.js").replace(/^a\//, "").replace(/^b\//, "");
      const g = buildSequenceDiagram({ code: n, oldCode: o, fileName });
      setNodes(g.nodes);
      setEdges(g.edges);
    } catch (e) {
      setError(e.message || "Failed to generate sequence diagram.");
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
    <div style={{ height: "100vh", display: "grid", gridTemplateColumns: "540px 1fr" }}>
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
          JS API Sequence Diagram + Differential
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

        <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.4 }}>
          API-focused view: participants are <strong>file-level handlers/functions</strong> and{" "}
          <strong>external systems</strong> (DB/cache/storage/services/modules). Messages are function-level calls.
        </div>

        {mode === "js" && (
          <>
            <label style={labelStyle}>JavaScript API File</label>
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
              Paste standard unified diff (`git diff`). Best results when the patch contains enough
              context to reconstruct a parseable file region.
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
          Generate Sequence Diagram
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
          <div><strong>Legend</strong></div>
          <div>• File contains participants</div>
          <div>• API Client → handler (inbound)</div>
          <div>• Handler/function → internal function / external system</div>
          <div>• Green edge = added call, Red dashed edge = deleted call</div>
          <div>• Edge label with “- / +” = changed call</div>
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
npm create vite@latest js-api-sequence-diff -- --template react
cd js-api-sequence-diff
npm install
npm install reactflow dagre @babel/parser @babel/traverse
npm run dev
```

A few practical notes:

* This is an **API-focused sequence view**, not full runtime tracing.
* It uses **static heuristics** (imports/clients/db/cache/storage names, function calls) to infer participants and messages.
* Differential mode highlights:

  * **added participants/calls** in green
  * **deleted participants/calls** in red
  * **changed call labels** as `- old` / `+ new` on the edge label
* Unified diff mode still needs enough patch context to reconstruct parseable code; otherwise use **Old/New** mode.