(function (root) {
  'use strict';

  // Snapshots contain JSON data only. Sorting object keys makes equivalent
  // snapshots compare equally while preserving the order of every array.
  function serialize(snapshot) {
    const value = JSON.stringify(snapshot, function (_, entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const ordered = Object.create(null);
      Object.keys(entry).sort().forEach(function (key) {
        ordered[key] = entry[key];
      });
      return ordered;
    });
    if (value === undefined) throw new TypeError('History snapshots must be JSON data.');
    return value;
  }

  class EditorHistory {
    constructor(limit = 60) {
      // The capacity includes the current snapshot. Keep at least one entry.
      this._limit = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : 60;
      this._entries = [];
      this._index = -1;
    }

    reset(snapshot) {
      this._entries = [serialize(snapshot)];
      this._index = 0;
    }

    commit(snapshot) {
      const serialized = serialize(snapshot);
      if (this._entries[this._index] === serialized) return false;
      this._entries = this._entries.slice(0, this._index + 1);
      this._entries.push(serialized);
      if (this._entries.length > this._limit) {
        this._entries.splice(0, this._entries.length - this._limit);
      }
      this._index = this._entries.length - 1;
      return true;
    }

    undo() {
      if (!this.canUndo) return null;
      this._index -= 1;
      return this.current;
    }

    redo() {
      if (!this.canRedo) return null;
      this._index += 1;
      return this.current;
    }

    get canUndo() {
      return this._index > 0;
    }

    get canRedo() {
      return this._index >= 0 && this._index < this._entries.length - 1;
    }

    get current() {
      return this._index < 0 ? null : JSON.parse(this._entries[this._index]);
    }
  }

  root.EditorHistory = EditorHistory;
  if (typeof module !== 'undefined' && module.exports) module.exports = EditorHistory;
})(globalThis);
