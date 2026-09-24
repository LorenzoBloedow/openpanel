export function printBoxMessage(title: string, lines: (string | unknown)[]) {
  console.log('┌──┐');
  console.log('│');
  if (title) {
    console.log(`│  ${title}`);
    if (lines.length) {
      console.log('│');
    }
  }
  lines.forEach((line) => {
    console.log(`│  ${line}`);
  });
  console.log('│');
  console.log('└──┘');
}

export function getIsSelfHosting() {
  return process.env.SELF_HOSTED === 'true' || !!process.env.SELF_HOSTED;
}

export function getIsDry() {
  return process.argv.includes('--dry');
}

export function getShouldIgnoreRecord() {
  return process.argv.includes('--no-record');
}
