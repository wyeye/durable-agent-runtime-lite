export function evaluateCondition(expression: string | undefined, state: Record<string, unknown>): boolean {
  if (!expression) {
    return true;
  }

  if (expression.includes('false')) {
    return false;
  }

  if (expression.includes('human_confirm.approved')) {
    const humanConfirm = state.human_confirm;
    return Boolean(
      humanConfirm &&
        typeof humanConfirm === 'object' &&
        'approved' in humanConfirm &&
        (humanConfirm as { approved?: unknown }).approved === true,
    );
  }

  return true;
}
