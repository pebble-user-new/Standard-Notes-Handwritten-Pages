export interface Action {
  undo(): void;
  redo(): void;
}

const LIMIT = 200;

export class History {
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];
  onChange: () => void = () => {};

  push(a: Action): void {
    this.undoStack.push(a);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const a = this.undoStack.pop();
    if (!a) return false;
    a.undo();
    this.redoStack.push(a);
    this.onChange();
    return true;
  }

  redo(): boolean {
    const a = this.redoStack.pop();
    if (!a) return false;
    a.redo();
    this.undoStack.push(a);
    this.onChange();
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange();
  }
}
