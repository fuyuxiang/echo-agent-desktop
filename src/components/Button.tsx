import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-solid" | "brand";
  size?: "compact" | "medium" | "large";
  loading?: boolean;
}

/** Native button semantics, including refs and submit behavior, with shared UI tokens. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "secondary", size = "medium", loading = false,
  type = "button", disabled, className = "", children, ...props
}, ref) {
  return <button {...props} ref={ref} type={type} disabled={disabled || loading}
    aria-busy={loading || props["aria-busy"]}
    className={`echo-button echo-button--${variant} echo-button--${size} ${className}`}>
    <span className={`echo-button__content${loading ? " echo-button__content--loading" : ""}`}>{children}</span>
    {loading && <Loader2 className="echo-button__spinner" aria-hidden="true" />}
  </button>;
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton({
  label, variant = "ghost", size = "compact", className = "", ...props
}, ref) {
  return <Button {...props} ref={ref} variant={variant} size={size} aria-label={label}
    className={`echo-button--icon-only ${className}`} />;
});
