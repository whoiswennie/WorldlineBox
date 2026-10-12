declare module "chardet" {
  export interface ChardetMatch {
    name: string;
    confidence: number;
  }

  export function analyse(buffer: Uint8Array): ChardetMatch[];
}
