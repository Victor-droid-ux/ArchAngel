"use client";

import React from "react";
import { cn, formatNumber, truncateAddress } from "@lib/utils";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 z-50">
      <div
        className={cn(
          "bg-base-100 rounded-xl shadow-xl w-full max-w-md mx-auto p-6 relative",
          className
        )}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-200"
        >
          <X size={18} />
        </button>
        {title && (
          <h2 className="text-lg font-semibold mb-3 border-b border-base-300 pb-2">
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>
  );
};
