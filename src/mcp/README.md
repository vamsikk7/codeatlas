# CodeAtlas MCP Server

Model Context Protocol (MCP) integration for CodeAtlas. Exposes architecture analysis tools and resources to AI assistants (Claude Desktop, IDE integrations).

## Tools

### `get_impact_analysis`

Analyze the blast radius of modifying files. Returns upstream callers (who breaks), downstream dependencies, affected clusters and services.

**Input:**
```json
{ "filePaths": ["src/services/userService.ts", "src/models/user.ts"] }
```

**Output:** ImpactResult with `changedFiles`, `impactedFunctions` (with depth/kind), `affectedClusterIds`, `affectedServiceIds`, `summary`.

### `get_function_dependencies`

Get callers (upstream) or callees (downstream) for a specific function.

**Input:**
```json
{
  "filePath": "src/services/userService.ts",
  "symbolName": "createUser",
  "direction": "upstream",
  "depth": 2
}
```

**Output:** List of dependent functions with file paths, depth, and call/import relationship kind.

## Resources

| URI | Description |
|-----|-------------|
| `codeatlas://workspace/microservices` | All detected services — name, technology, API count, inter-service connections |
| `codeatlas://workspace/apis` | All REST/GraphQL/gRPC endpoints — method, route, handler, file path |
| `codeatlas://workspace/features` | Feature clusters — label, file membership, cohesion, API count |

## Configuration

The MCP server starts automatically when CodeAtlas initializes. No additional configuration is needed.

To use with Claude Desktop, add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "node",
      "args": ["<extension-path>/dist/mcp-server.js", "--workspace", "/path/to/your/project"]
    }
  }
}
```

## Example Prompts

- "What would break if I changed `userService.ts`?" → triggers `get_impact_analysis`
- "Show me all API endpoints in the project" → reads `codeatlas://workspace/apis`
- "What services does the frontend call?" → reads `codeatlas://workspace/microservices`
- "Who calls the `createOrder` function?" → triggers `get_function_dependencies` with direction=upstream
