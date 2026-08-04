export interface SSEMessage {
  id?: string;
  event?: string;
  data: string;
}

export class SSEParser {
  private buffer: string = '';

  public parseChunk(chunk: string, onMessage: (msg: SSEMessage) => void) {
    this.buffer += chunk;
    
    let boundaryIndex;
    while ((boundaryIndex = this.buffer.indexOf('\n\n')) !== -1) {
      const messageRaw = this.buffer.slice(0, boundaryIndex);
      this.buffer = this.buffer.slice(boundaryIndex + 2);
      
      this.processMessage(messageRaw, onMessage);
    }
  }

  private processMessage(raw: string, onMessage: (msg: SSEMessage) => void) {
    const lines = raw.split('\n');
    let id: string | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith(':')) {
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        // Technically, a field name with no colon is parsed with empty string value, but for simplicity we ignore or handle gracefully
        // the spec says: if the line contains no colon, the whole line is the field name, empty value.
        // We will just process data, id, event.
        if (line === 'data' || line === 'id' || line === 'event') {
           if (line === 'data') dataLines.push('');
           if (line === 'id') id = '';
           if (line === 'event') event = '';
        }
        continue;
      }

      const field = line.slice(0, colonIndex);
      const valueRaw = line.slice(colonIndex + 1);
      const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;

      switch (field) {
        case 'id':
          id = value;
          break;
        case 'event':
          event = value;
          break;
        case 'data':
          dataLines.push(value);
          break;
      }
    }

    if (dataLines.length > 0) {
      onMessage({
        id,
        event,
        data: dataLines.join('\n')
      });
    }
  }

  public reset() {
    this.buffer = '';
  }
}
