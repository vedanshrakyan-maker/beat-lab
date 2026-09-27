"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { Button, type buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  render,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  /** Render extra UI from the result (e.g. rule checks). */
  render?: (state: ActionState) => ReactNode;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form
      action={formAction}
      className={cn("space-y-4", className)}
      key={resetOnSuccess && state.ok ? String(state.message) : undefined}
    >
      {children}
      <FormMessage state={state} />
      {render ? render(state) : null}
    </form>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (state.error)
    return (
      <p role="alert" className="border-bad/30 bg-bad/10 text-bad rounded-xl border px-3 py-2 text-sm">
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p role="status" className="border-good/30 bg-good/10 text-good rounded-xl border px-3 py-2 text-sm">
        {state.message}
      </p>
    );
  return null;
}

export function SubmitButton({
  children,
  pendingText,
  disabled,
  ...props
}: {
  children: ReactNode;
  pendingText?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
} & VariantProps<typeof buttonVariants>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? (pendingText ?? "Working…") : children}
    </Button>
  );
}
