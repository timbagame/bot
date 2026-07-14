export interface SingletonHandle<T, A extends unknown[] = []> {
  getInstance(...args: A): T;
  peek(): T | undefined;
  reset(): void;
}

export function createSingleton<T, A extends unknown[]>(
  factory: (...args: A) => T,
): SingletonHandle<T, A> {
  let instance: T | undefined;

  return {
    getInstance: (...args: A) => {
      if (!instance) {
        instance = factory(...args);
      }
      return instance;
    },
    peek: () => instance,
    reset: () => {
      instance = undefined;
    },
  };
}
