declare module 'universalify' {
    export function fromCallback(function_: (...args: any[]) => any): (...args: any[]) => Promise<any>;
}
