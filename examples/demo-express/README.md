# demo-express

A deliberately tiny Express app — three files, one route, one controller, one
stub database module.

It exists as a **dogfooding fixture**: the smallest thing that still produces
every CodeAtlas layer. Opening this folder as a workspace gives you an L1 with
one service, an L2b with one route, an L3 sequence for `GET /users`, an L4 file
graph, and an L5 flow for `getUsers`. Useful for eyeballing a change to the
graph builders without waiting on a real repository.

It previously sat loose at the repository root, where it looked like abandoned
production code and raised the reasonable question of why a VS Code extension
ships an Express server.

```
app.js                      — express() + one GET /users route
controllers/userController.js — the handler
db.js                       — stub query() returning []
```

Not wired into the test suite and intentionally not covered by it. For
verification against real codebases see `e2e/real-projects/`, which clones
actual framework repositories.
