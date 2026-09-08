/**
 * Generic name-keyed registry with defensive copying on the way in and out, so
 * a caller holding a definition cannot mutate what the registry serves next.
 */

export class Registry<T extends { readonly name: string }> {
  readonly #entries = new Map<string, T>();
  readonly #label: string;
  readonly #freeze: (value: T) => T;

  constructor(label: string, freeze: (value: T) => T = (v) => v) {
    this.#label = label;
    this.#freeze = freeze;
  }

  /**
   * Register a definition.
   *
   * A failed registration leaves every existing entry untouched — validation
   * runs to completion before anything is written.
   *
   * @throws If `validate` rejects, or the name is already taken.
   */
  register(definition: T, validate?: (d: T) => void): void {
    if (typeof definition?.name !== "string" || definition.name.trim() === "") {
      throw new Error(`${this.#label}: definition is missing a 'name'`);
    }
    if (definition.name.length > 100) {
      throw new Error(
        `${this.#label}: name '${definition.name}' exceeds 100 characters`
      );
    }
    if (this.#entries.has(definition.name)) {
      throw new Error(
        `${this.#label}: '${definition.name}' is already registered`
      );
    }
    validate?.(definition);
    this.#entries.set(definition.name, this.#freeze(definition));
  }

  get(name: string): T | undefined {
    const found = this.#entries.get(name);
    return found === undefined ? undefined : this.#freeze(found);
  }

  /** Like {@link get}, but throws rather than returning undefined. */
  require(name: string): T {
    const found = this.get(name);
    if (found === undefined) {
      throw new Error(`${this.#label}: '${name}' is not registered`);
    }
    return found;
  }

  getAll(): T[] {
    return [...this.#entries.values()].map(this.#freeze);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** Test helper — production code registers once at bootstrap. */
  clear(): void {
    this.#entries.clear();
  }
}
