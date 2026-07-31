import { describe, it, expect, mock } from "bun:test";
import { createTodoHook } from "../../src/hooks/todo-hook";

describe("createTodoHook", () => {
  it("should log progress for completed tasks", async () => {
    const mockLog = mock(() => Promise.resolve());
    const client = { app: { log: mockLog } };
    const hook = createTodoHook(client);

    await hook({
      todos: [
        { text: "task 1", done: true },
        { text: "task 2", done: false },
        { text: "task 3", done: false, status: "completed" }
      ]
    });

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith({
      body: {
        service: "flowdeck",
        level: "info",
        message: "[FlowDeck] Progress: 2/3 tasks",
      },
    });
  });

  it("should not log if there are no tasks", async () => {
    const mockLog = mock(() => Promise.resolve());
    const client = { app: { log: mockLog } };
    const hook = createTodoHook(client);

    await hook({ todos: [] });

    expect(mockLog).not.toHaveBeenCalled();
  });

  it("should not log if todos is not an array", async () => {
    const mockLog = mock(() => Promise.resolve());
    const client = { app: { log: mockLog } };
    const hook = createTodoHook(client);

    await hook({ todos: "not an array" });
    await hook({});

    expect(mockLog).not.toHaveBeenCalled();
  });

  it("should count 'done: true' and 'status: completed' as completed", async () => {
    const mockLog = mock(() => Promise.resolve());
    const client = { app: { log: mockLog } };
    const hook = createTodoHook(client);

    await hook({
      todos: [
        { text: "task 1", done: true },
        { text: "task 2", done: false, status: "completed" },
        { text: "task 3", done: false, status: "pending" },
        { text: "task 4", done: false }
      ]
    });

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith({
      body: {
        service: "flowdeck",
        level: "info",
        message: "[FlowDeck] Progress: 2/4 tasks",
      },
    });
  });
});
