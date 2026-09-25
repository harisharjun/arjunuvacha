/** Vite/vitest can import a file's contents as a string. Used so tests can read
 *  the migration SQL without pulling Node's types into a tsconfig shared with
 *  Worker code, which must never see them. */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
