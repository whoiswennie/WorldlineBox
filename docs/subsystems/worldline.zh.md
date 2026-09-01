# 世界线

[English](worldline.md) | 中文

世界线子系统把用户创作的正典转换为保留来源的冻结世界蓝图，在隔离的确定性工作线程中运行这些蓝图，并把结果状态投影为有界 AI 决策与文字游玩。它是既有会话、知识库和虚拟伙伴界面旁的一项可选产品能力。

## 权限与数据流

项目服务负责一个由用户选择的项目库根目录中的可变来源文档。编译器读取固定修订的来源快照，只冻结已经闭包的世界蓝图。演算服务从冻结构建创建逻辑演算；每个打开的演算由一个工作线程和一个 SQLite 写入者负责。内核的有界自治调度会通过交互游玩所使用的同一条校验动作路径推进角色、游戏历法、周期系统、记忆、关系与空间状态。AI 意图、调用、观察和叙事节拍都是持久证据，绝不是权威状态变化。

## 公共类型分组

- 项目类型覆盖根目录绑定、项目库分页、项目摘要、文档读取与乐观写入、历史、回收站、来源快照、冻结构建引用、传输任务，以及显式的项目、世界蓝图或演算归档请求。
- 编译器类型覆盖构建状态、诊断、创作问题、可审查提案、闭包证书、冻结构建和语义解释。
- 演算类型覆盖演算创建、有界确定性自治推演、视图、空间投影、选项、已验证行动、控制、有序记录分页、检查点、分支、AI 证据和事件解释。
- AI 与叙事类型覆盖模型目录、预算、有界上下文包、角色决策、流式文本、场景帧、文字行动、存档点和故事舞台渲染器。
- 会话上下文类型为 OC 作者会话携带可切换的当前项目、世界线、来源修订和可选演算权限。显式项目或演算标识可以自然切换当前项目，不会把会话永久钉死在一个项目上。

当前声明与字段级契约位于 [`packages/worldline/standard/src`](../../packages/worldline/standard/src)、[`packages/worldline/project/src/types.ts`](../../packages/worldline/project/src/types.ts)、[`packages/worldline/compiler/src/types.ts`](../../packages/worldline/compiler/src/types.ts)、[`packages/worldline/runtime/src/types.ts`](../../packages/worldline/runtime/src/types.ts)、[`packages/worldline/ai/src/types.ts`](../../packages/worldline/ai/src/types.ts) 和 [`packages/worldline/narrative/src/types.ts`](../../packages/worldline/narrative/src/types.ts)。

## 失败与兼容纪律

每次变更都限定在项目范围，并在实际提交操作中校验。归档在发布或解压前会完成预检与内容摘要校验。应用只接受当前格式契约；不兼容清单会明确失败，不会选择另一套旧实现。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworldlineai--worldlineai"></a>

### `ctx.worldlineAi` — `WorldlineAi`

Bounded one-shot model planner. Runtime remains the only authority that can change world state.

```ts cordis-catalog
/** Return the configured model catalog visible to Worldline routing.
 * @returns The result produced by the operation.
 */
@Remote('catalog') async catalog(): Promise<WorldlineAiCatalog>

/** Perform context pack through the package's public contract.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('contextPack') async contextPack(request: ContextPackRequest): Promise<ContextPack>

/** Return the current AI budget state for a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('budget') async budget(request: AiBudgetRequest): Promise<AiBudgetStatus>

/** Route one actor decision through policy, budget, and validation gates.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('decide') async decide(request: DecideForActorRequest): Promise<AiDecisionResult>

/** Host-only streaming primitive used by authority-constrained narrative and summary services.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
async *streamText(request: StreamWorldlineTextRequest): AsyncIterable<WorldlineTextChunk>
```

Source: [`packages/worldline/ai/src/index.ts:118`](../../packages/worldline/ai/src/index.ts)

<a id="ctxworldlinecompiler--worldlinecompiler"></a>

### `ctx.worldlineCompiler` — `WorldlineCompiler`

Host compiler gateway. All model-generated semantics enter through reviewable proposals.

```ts cordis-catalog
/** Return the latest compiler state for a project.
 * @param projectId - The project id supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('state') async state(projectId: ProjectId): Promise<CompilerState>

/** Compile a project snapshot and persist its diagnostics and draft output.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('compile') async compile(request: CompileWorldRequest): Promise<BuildPreview>

/** Perform answer question through the package's public contract.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('answerQuestion') async answerQuestion(request: AnswerQuestionRequest): Promise<CompilerState>

/** Apply submit proposal through the package's validated ownership boundary.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('submitProposal') async submitProposal(request: SubmitProposalRequest): Promise<CompilerState>

/** Perform review proposal through the package's public contract.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('reviewProposal') async reviewProposal(request: ReviewProposalRequest): Promise<CompilerState>

/** Freeze the latest valid draft into an immutable blueprint.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('freeze') async freeze(request: FreezeWorldRequest): Promise<FrozenBuild>

/** Explain one compiler diagnostic using stable source references.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('explain') async explain(request: ExplainSemanticsRequest): Promise<SemanticsExplanation>
```

Source: [`packages/worldline/compiler/src/index.ts:77`](../../packages/worldline/compiler/src/index.ts)

<a id="ctxworldlineconversationcontexts--worldlineconversationcontexts"></a>

### `ctx.worldlineConversationContexts` — `WorldlineConversationContexts`

Host owner of binding validation, persistence, lookup, and prompt projection.

```ts cordis-catalog
/** Return the active Worldline binding for a conversation.
 * @param session - The session supplied by the caller.
 * @returns The result produced by the operation.
 */
binding(session: Pick<Session, 'events'>): WorldlineConversationBinding | undefined

/** Select a conversation's active project and optional Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
async bind(request: BindWorldlineConversationRequest): Promise<WorldlineConversationBinding>
```

Types: [Session](session.md)

Source: [`packages/worldline/conversation-context/src/index.ts:78`](../../packages/worldline/conversation-context/src/index.ts)

<a id="ctxworldlinenarrative--worldlinenarrative"></a>

### `ctx.worldlineNarrative` — `WorldlineNarrative`

Text-play projection. It can phrase retained facts but has no world mutation primitive of its own.

```ts cordis-catalog
/** Perform register renderer through the package's public contract.
 * @param renderer - The renderer supplied by the caller.
 * @returns The result produced by the operation.
 */
registerRenderer(renderer: StoryStageRenderer): () => void

/** Return the current text-play scene.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('scene') async scene(request: TextPlayRequest): Promise<SceneFrame>

/** Open a text-play session for a Run and actor.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('open') async open(request: TextPlayRequest): Promise<TextPlayView>

/** Produce the next narration from authoritative Run records.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('narrate') async narrate(request: NarrateRequest): Promise<NarrativeBeat>

/** Perform narrate stream through the package's public contract.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
async *narrateStream(request: NarrateRequest): AsyncIterable<NarrativeStreamChunk>

/** Submit one listed text-play choice.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('choose') async choose(request: ChooseTextActionRequest): Promise<SubmitRunActionResult>

/** Perform free input through the package's public contract.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('freeInput') async freeInput(request: FreeTextActionRequest): Promise<FreeTextActionResult>

/** Rephrase presentation text without changing Run state.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('rephrase') async rephrase(request: RephraseRequest): Promise<NarrativeBeat>

/** Save the current text-play scene as a checkpoint.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('save') save(request: SaveTextPlayRequest): Promise<CheckpointView>

/** Branch text play from a saved checkpoint.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('branch') branch(request: BranchTextPlayRequest): Promise<RunView>

/** Retry narration from the latest authoritative Run state.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('retry') async retry(request: RetryTextActionRequest): Promise<SubmitRunActionResult>

/** Perform story stage through the package's public contract.
 * @returns The result produced by the operation.
 */
@Remote('storyStage') storyStage(): StoryStageStatus
```

Source: [`packages/worldline/narrative/src/index.ts:103`](../../packages/worldline/narrative/src/index.ts)

<a id="ctxworldlineprojects--worldlineprojects-abstract-seam"></a>

### `ctx.worldlineProjects` — `WorldlineProjects` (abstract seam)

Host-owned project storage contract; clients see only its generated Remote face.

```ts cordis-catalog
/** Return the active project-library root and its storage status.
 * @returns The result produced by the operation.
 */
abstract root(): Promise<ProjectRootView>

/** Relocate the project library root through the Host-owned storage boundary.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract setRoot(request: SetProjectRootRequest): Promise<RootRelocationPlan>

/** Query the paginated project library.
 * @param query - The query supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract library(query?: ProjectLibraryQuery): Promise<ProjectLibraryPage>

/** Rescan the active project root and refresh the library index.
 * @returns The result produced by the operation.
 */
abstract rescan(): Promise<TransferJob>

/** Create a project in the active project library.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract create(request: CreateProjectRequest): Promise<ProjectSummary>

/** Copy a project while preserving the source project.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract copyProject(request: CopyProjectRequest): Promise<ProjectSummary>

/** Move a project into the recoverable project recycle bin.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract trashProject(request: TrashProjectRequest): Promise<TrashedProject>

/** List projects currently available for recovery.
 * @returns The result produced by the operation.
 */
abstract listTrashedProjects(): Promise<readonly TrashedProject[]>

/** Permanently remove every project currently held in the project recycle bin.
 * @returns The number of project entries removed.
 */
abstract emptyProjectTrash(): Promise<number>

/** Restore a project from the project recycle bin.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract restoreProject(request: RestoreProjectRequest): Promise<ProjectSummary>

/** List one project directory from the authoritative Host store.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract tree(request: ProjectTreeRequest): Promise<ProjectTreeListing>

/** Read a project document from the authoritative Host store.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract read(request: ReadDocumentRequest): Promise<DocumentView>

/** Persist a project document through the Host-owned storage boundary.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract write(request: WriteDocumentRequest): Promise<DocumentView>

/** Stream one browser-owned file without placing its bytes in Remote JSON or Host memory.
 * @param request - The request supplied by the caller.
 * @param source - The source supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract importEntry( request: ImportProjectEntryRequest, source: AsyncIterable<Uint8Array>, ): Promise<MutationResult>

/** Create a directory inside a project.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract createDirectory(request: CreateDirectoryRequest): Promise<MutationResult>

/** Move or rename an entry inside a project.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract move(request: MoveEntryRequest): Promise<MutationResult>

/** Copy an entry while preserving the source entry.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract copyEntry(request: CopyEntryRequest): Promise<MutationResult>

/** Move a project entry into the recoverable entry recycle bin.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract trashEntry(request: TrashEntryRequest): Promise<TrashedEntry>

/** List recoverable entries for a project.
 * @param projectId - The project id supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract listTrashedEntries(projectId: TrashEntryRequest['projectId']): Promise<readonly TrashedEntry[]>

/** Restore an entry from the project recycle bin.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract restoreEntry(request: RestoreEntryRequest): Promise<MutationResult>

/** Read the revision history of a project document.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract history(request: HistoryRequest): Promise<readonly DocumentHistoryEntry[]>

/** Restore a historical document revision as the current content.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract restoreRevision(request: RestoreRevisionRequest): Promise<DocumentView>

/** Search indexed content inside one project.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract search(request: SearchProjectRequest): Promise<readonly ProjectSearchHit[]>

/** Find documents that link to the requested document.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract backlinks(request: ReadDocumentRequest): Promise<readonly ProjectLink[]>

/** Export a project to a user-selected archive path.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract exportProject(request: ExportProjectRequest): Promise<TransferJob>

/** Import a project archive selected by the user.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract importProject(request: ImportProjectRequest): Promise<TransferJob>

/** Export a compiled blueprint to a user-selected archive path.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract exportBlueprint(request: ExportBlueprintRequest): Promise<TransferJob>

/** Import a compiled blueprint archive selected by the user.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract importBlueprint(request: ImportBlueprintRequest): Promise<TransferJob>

/** Export a Run archive to a user-selected path.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract exportRun(request: ExportRunRequest): Promise<TransferJob>

/** Import a Run archive selected by the user.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract importRun(request: ImportRunRequest): Promise<TransferJob>

/** Read the current state of an import or export transfer.
 * @param id - The id supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract transfer(id: string): Promise<TransferJob>

/** Apply cancel transfer through the package's validated ownership boundary.
 * @param id - The id supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract cancelTransfer(id: string): Promise<TransferJob>

/** Capture all text sources at one point for a Host-side compiler. Not exported over Remote.
 * @param projectId - The project id supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract sourceSnapshot(projectId: ProjectTreeRequest['projectId']): Promise<ProjectSourceSnapshot>

/** Read a namespaced Host-only compiler/runtime sidecar. Not exported over Remote.
 * @param projectId - The project id supplied by the caller.
 * @param namespace - The namespace supplied by the caller.
 * @param path - The path supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract readControl( projectId: ProjectTreeRequest['projectId'], namespace: string, path: string, ): Promise<ProjectControlDocument | undefined>

/** Durably write a namespaced Host-only sidecar with optimistic concurrency.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract writeControl(request: WriteProjectControlRequest): Promise<ProjectControlDocument>

/** Commit an immutable build directory and activate it only after every artifact is durable.
 * @param request - The request supplied by the caller.
 */
abstract storeBuild(request: StoreProjectBuildRequest): Promise<void>

/** Locate the immutable active Blueprint for a Worker without reading it on the Host event loop.
 * @param projectId - The project id supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract activeBuild(projectId: ProjectId): Promise<ActiveProjectBuild | undefined>

/** Allocate or locate one project-scoped Run database path.
 * @param projectId - The project id supplied by the caller.
 * @param runId - The run id supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract runStorage(projectId: ProjectId, runId: RunId): Promise<ProjectRunStorage>

/** Discover persisted Run databases across the configured library.
 * @returns The result produced by the operation.
 */
abstract runStorages(): Promise<readonly ProjectRunStorage[]>

/** Perform remote root through the package's public contract.
 * @returns The result produced by the operation.
 */
@Remote('root') remoteRoot(): Promise<ProjectRootView>

/** Perform remote set root through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('setRoot') remoteSetRoot(value: SetProjectRootRequest): Promise<RootRelocationPlan>

/** Perform remote library through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('library') remoteLibrary(value?: ProjectLibraryQuery): Promise<ProjectLibraryPage>

/** Perform remote rescan through the package's public contract.
 * @returns The result produced by the operation.
 */
@Remote('rescan') remoteRescan(): Promise<TransferJob>

/** Perform remote create through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('create') remoteCreate(value: CreateProjectRequest): Promise<ProjectSummary>

/** Perform remote copy project through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('copyProject') remoteCopyProject(value: CopyProjectRequest): Promise<ProjectSummary>

/** Perform remote trash project through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('trashProject') remoteTrashProject(value: TrashProjectRequest): Promise<TrashedProject>

/** Perform remote list trashed projects through the package's public contract.
 * @returns The result produced by the operation.
 */
@Remote('listTrashedProjects') remoteListTrashedProjects(): Promise<readonly TrashedProject[]>

/** Permanently remove every project currently held in the project recycle bin.
 * @returns The number of project entries removed.
 */
@Remote('emptyProjectTrash') remoteEmptyProjectTrash(): Promise<number>

/** Perform remote restore project through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('restoreProject') remoteRestoreProject(value: RestoreProjectRequest): Promise<ProjectSummary>

/** Perform remote tree through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('tree') remoteTree(value: ProjectTreeRequest): Promise<ProjectTreeListing>

/** Perform remote read through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('read') remoteRead(value: ReadDocumentRequest): Promise<DocumentView>

/** Perform remote write through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('write') remoteWrite(value: WriteDocumentRequest): Promise<DocumentView>

/** Perform remote create directory through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('createDirectory') remoteCreateDirectory(value: CreateDirectoryRequest): Promise<MutationResult>

/** Perform remote move through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('move') remoteMove(value: MoveEntryRequest): Promise<MutationResult>

/** Perform remote copy entry through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('copyEntry') remoteCopyEntry(value: CopyEntryRequest): Promise<MutationResult>

/** Perform remote trash entry through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('trashEntry') remoteTrashEntry(value: TrashEntryRequest): Promise<TrashedEntry>

/** Perform remote list trashed entries through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('listTrashedEntries') remoteListTrashedEntries(value: TrashEntryRequest['projectId']): Promise<readonly TrashedEntry[]>

/** Perform remote restore entry through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('restoreEntry') remoteRestoreEntry(value: RestoreEntryRequest): Promise<MutationResult>

/** Perform remote history through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('history') remoteHistory(value: HistoryRequest): Promise<readonly DocumentHistoryEntry[]>

/** Perform remote restore revision through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('restoreRevision') remoteRestoreRevision(value: RestoreRevisionRequest): Promise<DocumentView>

/** Perform remote search through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('search') remoteSearch(value: SearchProjectRequest): Promise<readonly ProjectSearchHit[]>

/** Perform remote backlinks through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('backlinks') remoteBacklinks(value: ReadDocumentRequest): Promise<readonly ProjectLink[]>

/** Perform remote export project through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('exportProject') remoteExportProject(value: ExportProjectRequest): Promise<TransferJob>

/** Perform remote import project through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('importProject') remoteImportProject(value: ImportProjectRequest): Promise<TransferJob>

/** Perform remote export blueprint through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('exportBlueprint') remoteExportBlueprint(value: ExportBlueprintRequest): Promise<TransferJob>

/** Perform remote import blueprint through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('importBlueprint') remoteImportBlueprint(value: ImportBlueprintRequest): Promise<TransferJob>

/** Perform remote export run through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('exportRun') remoteExportRun(value: ExportRunRequest): Promise<TransferJob>

/** Perform remote import run through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('importRun') remoteImportRun(value: ImportRunRequest): Promise<TransferJob>

/** Perform remote transfer through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('transfer') remoteTransfer(value: string): Promise<TransferJob>

/** Perform remote cancel transfer through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('cancelTransfer') remoteCancelTransfer(value: string): Promise<TransferJob>
```

Source: [`packages/worldline/project/src/index.ts:57`](../../packages/worldline/project/src/index.ts)

<a id="ctxworldlineruns--worldlineruns-abstract-seam"></a>

### `ctx.worldlineRuns` — `WorldlineRuns` (abstract seam)

Replaceable Host Run supervisor; the generated Remote face never exposes paths or Worker handles.

```ts cordis-catalog
/** Create a Run from a validated compiled blueprint.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract create(request: CreateRunRequest): Promise<RunView>

/** List Runs from the authoritative Host registry.
 * @returns The result produced by the operation.
 */
abstract list(): Promise<readonly RunSummary[]>

/** Return the current authoritative view of a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract view(request: RunRef): Promise<RunView>

/** Return the immutable definition used to create a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract definition(request: RunRef): Promise<RunDefinitionView>

/** Return the current spatial state of a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract spatial(request: RunSpatialRequest): Promise<RunSpatialView>

/** Return the actions currently available to the controlled actor.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract choices(request: RunChoicesRequest): Promise<RunChoicesView>

/** Advance deterministic simulation time for a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract advance(request: AdvanceRunRequest): Promise<RunView>

/** Run bounded deterministic actor cycles inside the owning Runtime worker.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract simulate(request: SimulateRunRequest): Promise<SimulateRunResult>

/** Apply submit action through the package's validated ownership boundary.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract submitAction(request: SubmitRunActionRequest): Promise<SubmitRunActionResult>

/** Pause a running Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract pause(request: RunRef): Promise<RunView>

/** Resume a paused Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract resume(request: RunRef): Promise<RunView>

/** Stop a Run and release its worker resources.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract stop(request: RunRef): Promise<RunSummary>

/** Read a filtered page from the append-only Run record stream.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract records(request: RunRecordsRequest): Promise<RunRecordsPage>

/** Create a named checkpoint for the current Run state.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract checkpoint(request: CreateCheckpointRequest): Promise<CheckpointView>

/** List checkpoints stored for a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract checkpoints(request: RunRef): Promise<readonly CheckpointView[]>

/** Branch a new Run from an existing checkpoint.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract branch(request: BranchRunRequest): Promise<RunView>

/** Change an actor's control mode through the Run supervisor.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract setControl(request: SetActorControlRequest): Promise<RunView>

/** Enable or disable AI participation for a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract setAiEnabled(request: SetAiEnabledRequest): Promise<RunView>

/** Set the explicit bounded AI allowance for a Run.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract setAiBudget(request: SetAiBudgetRequest): Promise<RunView>

/** Perform switch model through the package's public contract.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract switchModel(request: SwitchModelPolicyRequest): Promise<RunView>

/** Explain a recorded Run event from authoritative inputs.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract explain(request: ExplainRunEventRequest): Promise<RunEventExplanation>

/** Host-only: persist a model intent and its actual usage before attempting its Action.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract recordAiIntent(request: RecordAiIntentRequest): Promise<RecordAiIntentResult>

/** Host-only: account every routed call, regardless of whether it yields an intent.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract recordAiInvocation(request: RecordAiInvocationRequest): Promise<RecordAiInvocationResult>

/** Host-only: persist prose derived from retained events/observations without changing world state.
 * @param request - The request supplied by the caller.
 * @returns The result produced by the operation.
 */
abstract recordNarrativeBeat(request: RecordNarrativeBeatRequest): Promise<RecordNarrativeBeatResult>

/** Perform remote create through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('create') remoteCreate(value: CreateRunRequest): Promise<RunView>

/** Perform remote list through the package's public contract.
 * @returns The result produced by the operation.
 */
@Remote('list') remoteList(): Promise<readonly RunSummary[]>

/** Perform remote view through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('view') remoteView(value: RunRef): Promise<RunView>

/** Perform remote definition through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('definition') remoteDefinition(value: RunRef): Promise<RunDefinitionView>

/** Perform remote spatial through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('spatial') remoteSpatial(value: RunSpatialRequest): Promise<RunSpatialView>

/** Perform remote choices through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('choices') remoteChoices(value: RunChoicesRequest): Promise<RunChoicesView>

/** Perform remote advance through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('advance') remoteAdvance(value: AdvanceRunRequest): Promise<RunView>

/** Run bounded autonomous cycles without routing through an Agent or model.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('simulate') remoteSimulate(value: SimulateRunRequest): Promise<SimulateRunResult>

/** Perform remote submit action through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('submitAction') remoteSubmitAction(value: SubmitRunActionRequest): Promise<SubmitRunActionResult>

/** Perform remote pause through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('pause') remotePause(value: RunRef): Promise<RunView>

/** Perform remote resume through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('resume') remoteResume(value: RunRef): Promise<RunView>

/** Perform remote stop through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('stop') remoteStop(value: RunRef): Promise<RunSummary>

/** Perform remote records through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('records') remoteRecords(value: RunRecordsRequest): Promise<RunRecordsPage>

/** Perform remote checkpoint through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('checkpoint') remoteCheckpoint(value: CreateCheckpointRequest): Promise<CheckpointView>

/** Perform remote checkpoints through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('checkpoints') remoteCheckpoints(value: RunRef): Promise<readonly CheckpointView[]>

/** Perform remote branch through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('branch') remoteBranch(value: BranchRunRequest): Promise<RunView>

/** Perform remote set control through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('setControl') remoteSetControl(value: SetActorControlRequest): Promise<RunView>

/** Perform remote set ai enabled through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('setAiEnabled') remoteSetAiEnabled(value: SetAiEnabledRequest): Promise<RunView>

/** Update the Run AI budget through the generated Remote boundary.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('setAiBudget') remoteSetAiBudget(value: SetAiBudgetRequest): Promise<RunView>

/** Perform remote switch model through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('switchModel') remoteSwitchModel(value: SwitchModelPolicyRequest): Promise<RunView>

/** Perform remote explain through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
@Remote('explain') remoteExplain(value: ExplainRunEventRequest): Promise<RunEventExplanation>
```

Source: [`packages/worldline/runtime/src/index.ts:44`](../../packages/worldline/runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
