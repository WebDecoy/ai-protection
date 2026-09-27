import { readFile } from 'node:fs/promises';
import { summarize } from './observation.mjs';
const [eventsPath, labelsPath] = process.argv.slice(2);
if (!eventsPath || !labelsPath || process.argv.length !== 4) throw new Error('Usage: node report.mjs events.jsonl independent-labels.jsonl');
const read = async path => (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
console.log(JSON.stringify(summarize(await read(eventsPath), await read(labelsPath)), null, 2));
