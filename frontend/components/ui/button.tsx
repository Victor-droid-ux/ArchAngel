import * as React from "react";
import { cn, formatNumber, truncateAddress } from "@lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "outline";
  size?: "sm" | "md" | "lg";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const base = "rounded-xl font-semibold focus:outline-none transition-all";

    const variants = {
      primary: "bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-300",
      secondary:
        "bg-base-200 hover:bg-base-300 text-neutral-content border border-base-300",
      danger: "bg-red-600 hover:bg-red-700 text-white disabled:bg-red-300",
      ghost:
        "bg-transparent hover:bg-base-200 text-neutral-content border border-transparent",
      outline:
        "bg-transparent hover:bg-base-200 text-neutral-content border border-base-300",
    }[variant];

    const sizes = {
      sm: "px-3 py-1 text-sm",
      md: "px-4 py-2 text-base",
      lg: "px-6 py-3 text-lg",
    }[size];

    return (
      <button
        ref={ref}
        className={cn(base, variants, sizes, className)}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
