# Session, Turn, and Tool Lifecycle

English | [中文](session-turn-lifecycle.zh.md)

## Durable facts

The Session Event Log is the shared source for model history, recovery, forks, UI projections, queries, and telemetry. Everything entering a model request must be reconstructible from the log; transient UI state stays outside it.

## Turn flow

```text
turn/start
  -> claim inbox input
  -> agent/pre-step
  -> step/start
  -> user/message
  -> derive model history + assemble prompt/tools
  -> agent/request -> llm stream -> assistant events
  -> tool/call -> tools/pre-execute -> execute -> post-execute -> tool/result
  -> step/end
  -> continue when work is owed, otherwise agent/turn-stopping
turn/end
```

One Turn may contain multiple Steps. A Step is one model request and its tool batch. Rejected or empty input still produces an explainable durable Turn ending instead of leaving half-open state.

## Tool execution

Tool schema, presentation, execution, and output projection belong to one `ToolDefinition`. Arguments are validated at the model/JSON boundary; execution normalizes results into a success-or-failure discriminated union; post-execute policy may replace the projection, add next-turn context, or block a result.

The tool cancellation signal covers the call, Provider, and underlying resources. Fiber disposal stops unfinished calls and prevents them from writing success events after cancellation.

## Recovery and derivation

- Persistence backends store the log without owning Agent semantics.
- Projections derive lists, statistics, and UI data from the log.
- Compaction creates a new durable context fact instead of secretly mutating in-memory history.
- Forking copies durable events before an explicit boundary and never copies live process resources.
