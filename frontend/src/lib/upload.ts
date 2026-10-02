/**
 * CodeConClave — multipart upload with progress (XHR).
 * Mirrors the api() envelope + CSRF rules so in-chat attachments can show
 * real upload progress. Returns the uploaded file row (data.files[0]).
 */
export interface UploadedFileRow {
  id: string;
  name: string;
  [key: string]: unknown;
}

export function uploadFileWithProgress(
  file: File,
  fields: Record<string, string>,
  onProgress: (fraction: number) => void,
): Promise<UploadedFileRow> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/files/upload');
    const csrf = document.cookie.match(/(?:^|; )codeconclave_csrf=([^;]+)/)?.[1] ?? '';
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', decodeURIComponent(csrf));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { data?: { files?: UploadedFileRow[] } };
          const fileRow = body?.data?.files?.[0];
          if (fileRow?.id) resolve(fileRow);
          else reject(new Error('Upload response did not include the file.'));
        } catch {
          reject(new Error('Invalid upload response.'));
        }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          if (body?.error?.message) msg = body.error.message;
        } catch {
          /* keep default */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    const form = new FormData();
    form.append('files', file, file.name);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    xhr.send(form);
  });
}