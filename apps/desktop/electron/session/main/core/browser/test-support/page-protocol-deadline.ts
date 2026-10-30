export async function withinDeadline<T>(operation: Promise<T>, label: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
