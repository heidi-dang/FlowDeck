export class FakeRepository<T extends { id: string }> {
  private data: Map<string, T> = new Map();
  
  async save(entity: T): Promise<void> {
    this.data.set(entity.id, { ...entity });
  }
  
  async findById(id: string): Promise<T | null> {
    const entity = this.data.get(id);
    return entity ? { ...entity } : null;
  }
  
  async findAll(): Promise<T[]> {
    return Array.from(this.data.values());
  }
  
  async delete(id: string): Promise<void> {
    this.data.delete(id);
  }
}
