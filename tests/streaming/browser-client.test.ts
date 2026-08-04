import { expect, test, describe, mock, beforeEach, afterEach } from "bun:test";
import { SSEParser } from "../../src/orchestration/streaming/sse-parser";
import { SequenceTracker } from "../../src/orchestration/streaming/sequence-tracker";
import { FlowDeckStreamClient } from "../../src/orchestration/streaming/browser-client";
import { ConnectionState } from "../../src/orchestration/streaming/connection-state";

describe("SSEParser", () => {
  test("parses single chunk", () => {
    const parser = new SSEParser();
    const messages: any[] = [];
    
    parser.parseChunk("data: hello\n\n", msg => messages.push(msg));
    
    expect(messages.length).toBe(1);
    expect(messages[0].data).toBe("hello");
  });

  test("parses split chunks across buffer boundaries", () => {
    const parser = new SSEParser();
    const messages: any[] = [];
    
    parser.parseChunk("id: 123\n", msg => messages.push(msg));
    parser.parseChunk("data: hel", msg => messages.push(msg));
    parser.parseChunk("lo\n\n", msg => messages.push(msg));
    
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe("123");
    expect(messages[0].data).toBe("hello");
  });
  
  test("ignores comments", () => {
     const parser = new SSEParser();
     const messages: any[] = [];
     parser.parseChunk(": heartbeat\ndata: value\n\n", msg => messages.push(msg));
     expect(messages.length).toBe(1);
     expect(messages[0].data).toBe("value");
  });
});

describe("SequenceTracker", () => {
  test("filters duplicates", () => {
    const tracker = new SequenceTracker();
    expect(tracker.track("123")).toBe(true);
    expect(tracker.track("123")).toBe(false);
  });
  
  test("handles snapshot reset", () => {
    const tracker = new SequenceTracker();
    tracker.track("123");
    tracker.handleSnapshot();
    expect(tracker.track("123")).toBe(true);
  });
});

describe("BrowserClient", () => {
   let originalFetch: typeof global.fetch;

   beforeEach(() => {
     originalFetch = global.fetch;
   });
   
   afterEach(() => {
     global.fetch = originalFetch;
   });
   
   test("successful connection and state transitions", async () => {
       const mockReader = {
         read: mock().mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("data: test\n\n") })
                     .mockResolvedValueOnce({ done: true })
       };
       (global as any).fetch = mock().mockResolvedValue({
         ok: true,
         body: { getReader: () => mockReader }
       } as any);
       
       const states: ConnectionState[] = [];
       const client = new FlowDeckStreamClient({
         url: "http://test",
         onStateChange: (s) => states.push(s)
       });
       
       await client.start();
       
       expect(states).toEqual(['connecting', 'live', 'completed']);
   });
   
   test("handles abort properly", async () => {
       const mockReader = {
         read: mock().mockImplementation(async () => {
             // Simulate infinite read that gets aborted
             return new Promise(resolve => setTimeout(() => resolve({ done: true }), 100));
         })
       };
       (global as any).fetch = mock().mockResolvedValue({
         ok: true,
         body: { getReader: () => mockReader }
       } as any);
       
       const states: ConnectionState[] = [];
       const client = new FlowDeckStreamClient({
         url: "http://test",
         onStateChange: (s) => states.push(s)
       });
       
       const startPromise = client.start();
       client.abort();
       await startPromise;
       
       expect(states).toContain('cancelled');
   });
});
