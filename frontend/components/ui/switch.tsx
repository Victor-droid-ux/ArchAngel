"use client";

import * as React from "react";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const Switch: React.FC<SwitchProps> = ({ checked, onCheckedChange }) => {
  return (
    <button
      onClick={() => onCheckedChange(!checked)}
      className={`w-11 h-6 rounded-full transition-colors duration-200 ${
        checked ? "bg-blue-600" : "bg-gray-400"
      } relative`}
    >
      <span
        className={`block w-5 h-5 bg-white rounded-full shadow-md absolute top-0.5 transition-transform duration-200 ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      ></span>
    </button>
  );
};
