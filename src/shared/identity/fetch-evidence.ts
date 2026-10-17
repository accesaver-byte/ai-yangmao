import {z} from 'zod';
const url=z.url().refine(value=>{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;});
/** Supplied by authenticated collector code, never by model output or display tier. */
export const sourceFetchSchema=z.strictObject({originalUrl:url,finalUrl:url,fetchedUrl:url,method:z.enum(['direct','readability','jina','exa','first_party_embed']),sourceVerified:z.boolean(),truncated:z.boolean(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),originalContentHash:z.string().regex(/^[a-f0-9]{64}$/).optional()});
export type SourceFetch=z.infer<typeof sourceFetchSchema>;
