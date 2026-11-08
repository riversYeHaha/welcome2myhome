import type { FastifyRequest } from 'fastify';
import { AppError } from './errors';

export interface MultipartPayload {
  fields: Record<string, string>;
  file?: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
  };
}

/** Read one file plus text fields from a multipart request. */
export async function readMultipart(request: FastifyRequest): Promise<MultipartPayload> {
  const fields: Record<string, string> = {};
  let file: MultipartPayload['file'];

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (file) {
          await part.toBuffer();
          continue;
        }
        file = {
          buffer: await part.toBuffer(),
          filename: part.filename,
          mimeType: part.mimetype,
        };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_UPLOAD', 422, '上传内容无法解析，请重试');
  }

  return { fields, file };
}
