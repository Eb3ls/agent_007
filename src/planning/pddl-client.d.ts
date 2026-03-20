// Type declarations for @unitn-asa/pddl-client (T18)

declare module '@unitn-asa/pddl-client' {
  export interface PddlPlanStep {
    parallel: boolean;
    action: string;
    args: string[];
  }

  /** Call the online PDDL solver with raw domain and problem PDDL strings. */
  export function onlineSolver(
    domain: string,
    problem: string,
  ): Promise<PddlPlanStep[]>;

  export class PddlDomain {
    constructor(name: string, ...actions: PddlAction[]);
    addPredicate(predicate: string): boolean;
    addAction(...actions: PddlAction[]): void;
    toPddlString(): string;
  }

  export class PddlProblem {
    constructor(name: string, objects: string, init: string, goal: string);
    toPddlString(): string;
  }

  export class PddlAction {
    constructor(
      name: string,
      parameters: string,
      precondition: string,
      effect: string,
      executor?: (...args: unknown[]) => unknown,
    );
    toPddlString(): string;
  }
}
