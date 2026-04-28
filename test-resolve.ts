import { ProjectIndex } from './src/project/project-index.js';
import { parseSource } from './src/parser/c3-parser.js';

const index = new ProjectIndex();

const helloCode = `
module hello;
import std::io;

fn void main() {
    io::printn("hello");
}
`;

const stdlibCode = `
module std::io;

fn void printn(String s) {}
`;

const helloDoc = parseSource('hello.c3', helloCode);
const stdDoc = parseSource('stdlib.c3', stdlibCode);

index.upsert(helloDoc);
index.upsert(stdDoc);

console.log('imports:', helloDoc.imports);

console.log('resolving:', index.resolveSymbol('hello.c3', 'io::printn', { line: 5, character: 10 }));
