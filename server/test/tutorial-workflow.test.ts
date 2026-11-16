import { test } from "node:test";
import assert from "node:assert/strict";
import { workflowSchema, workflowSummary } from "../src/tutorial-workflow.js";
import { contentSchemas } from "../src/management.js";
import { workflowGraphError, workflowMediaKey, workflowMediaUrl, workflowNodeTypes, type WorkflowDocument } from "../../shared/tutorial-workflow.js";

const mediaId = "c8514b13-ad4a-4c7e-a356-ea3cd0f3bd0c";
function workflow(): WorkflowDocument {
    return { version: 1, nodes: workflowNodeTypes.map(type => ({ id: type, type, title: type, position: { x: 0, y: 0 }, width: 200, height: 120, metadata: { status: "idle", ...(type !== "group" ? { groupId: "group" } : {}) } })), connections: [{ id: "edge", fromNodeId: "text", toNodeId: "config" }], models: { config: { name: "model-a", capability: "image" } }, media: [] };
}
function withMedia(): WorkflowDocument {
    const flow = workflow();
    flow.media = [{ mediaId, bytes: 4, mimeType: "audio/mpeg", sha256: "a".repeat(64) }];
    flow.nodes.find(node => node.id === "audio")!.metadata = { content: workflowMediaUrl(mediaId), storageKey: workflowMediaKey(mediaId), bytes: 4, mimeType: "audio/mpeg", status: "success" };
    flow.nodes.find(node => node.id === "config")!.metadata!.references = [workflowMediaUrl(mediaId)];
    return flow;
}

test("workflow tutorials keep six built-in nodes, layout, parameters and portable model names", () => {
    const flow = withMedia();
    assert.deepEqual(workflowSchema.parse(flow), flow);
    const data = contentSchemas.tutorials.parse({ title: "流程", format: "workflow", workflow: flow });
    assert.equal(data.workflow?.nodes.length, 6);
    assert.ok(!("workflow" in workflowSummary(data)));
    assert.deepEqual(workflowSummary(data).workflowSummary, { nodeCount: 6, connectionCount: 1 });
    assert.equal(contentSchemas.tutorials.parse({ title: "正文", format: "markdown", content: "# 教程" }).content, "# 教程");
    assert.equal(contentSchemas.tutorials.parse({ title: "链接", format: "link", href: "/image" }).href, "/image");
    assert.throws(() => contentSchemas.tutorials.parse({ title: "缺流程", format: "workflow" }));
    assert.throws(() => contentSchemas.tutorials.parse({ title: "类型不符", format: "link", href: "/image", workflow: flow }));
});

test("workflow validation rejects broken graph identities, groups, primary items and model bindings", () => {
    const cases: Array<[(flow: WorkflowDocument) => void, RegExp]> = [
        [flow => { flow.nodes.push(flow.nodes[0]); }, /节点 ID 重复/],
        [flow => { flow.connections.push(flow.connections[0]); }, /连线 ID 重复/],
        [flow => { flow.connections[0].toNodeId = "missing"; }, /不存在的节点/],
        [flow => { flow.nodes[0].metadata!.groupId = "text"; }, /分组引用无效/],
        [flow => { flow.nodes.find(node => node.type === "group")!.metadata!.groupId = "group"; }, /循环/],
        [flow => { flow.nodes[0].metadata!.primaryTextId = "missing"; }, /主内容引用无效/],
        [flow => { flow.nodes[0].metadata!.composerContent = "@[node:missing]"; }, /提示词引用了不存在的节点/],
        [flow => { flow.models.missing = { name: "x", capability: "text" }; }, /不存在的节点/],
        [flow => { flow.models.config.capability = "audio"; }, /能力与节点/],
    ];
    for (const [change, reason] of cases) {
        const flow = workflow(); change(flow);
        assert.match(workflowGraphError(flow)!, reason);
        assert.throws(() => workflowSchema.parse(flow), reason);
    }
    assert.throws(() => workflowSchema.parse({ ...workflow(), version: 2 }));
    assert.throws(() => workflowSchema.parse({ ...workflow(), nodes: [] }));
});

test("workflow whitelist rejects plugin nodes, credentials, account IDs and transient generation state", () => {
    const plugin = workflow(); plugin.nodes[0].type = "plugin:node" as never;
    assert.throws(() => workflowSchema.parse(plugin));
    for (const field of ["model", "channelId", "apiKey", "baseUrl", "videoTaskId", "videoTaskProvider", "videoTaskReport", "errorDetails"]) {
        const flow = workflow(); Object.assign(flow.nodes[0].metadata!, { [field]: "private" });
        assert.throws(() => workflowSchema.parse(flow), undefined, field);
    }
    for (const field of ["chatSessions", "activeChatId", "tasks"]) assert.throws(() => workflowSchema.parse({ ...workflow(), [field]: [] }));
    const loading = workflow(); Object.assign(loading.nodes[0].metadata!, { status: "loading" });
    assert.throws(() => workflowSchema.parse(loading));
});

test("workflow media must be complete, used, type-correct public references", () => {
    const invalid: Array<(flow: WorkflowDocument) => void> = [
        flow => { flow.media = []; },
        flow => { flow.media.push(flow.media[0]); },
        flow => { flow.nodes.find(node => node.id === "audio")!.metadata!.content = "blob:local-only"; },
        flow => { flow.nodes.find(node => node.id === "audio")!.metadata!.storageKey = "audio:local-only"; },
        flow => { flow.nodes.find(node => node.id === "audio")!.metadata!.bytes = 5; },
        flow => { flow.media[0].mimeType = "video/mp4"; },
        flow => { flow.media.push({ ...flow.media[0], mediaId: "01153385-185d-4e19-a2e2-489e4eb80da3" }); },
        flow => { flow.media[0].sha256 = "invalid"; },
    ];
    for (const change of invalid) { const flow = withMedia(); change(flow); assert.throws(() => workflowSchema.parse(flow)); }
});
