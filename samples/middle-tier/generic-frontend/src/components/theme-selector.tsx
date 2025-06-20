"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

type Theme = "light" | "dark" | "dark-blue";

function applyTheme(theme: Theme) {
  document.documentElement.classList.remove("dark", "dark-blue");
  if (theme !== "light") {
    document.documentElement.classList.add(theme);
  }
}

export default function ThemeSelector() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const initial =
      stored ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    setTheme(initial);
    applyTheme(initial);
  }, []);

  const handleChange = (value: Theme) => {
    setTheme(value);
    localStorage.setItem("theme", value);
    applyTheme(value);
  };

  return (
    <Select value={theme} onValueChange={handleChange}>
      <SelectTrigger className="w-[120px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="light">Light</SelectItem>
        <SelectItem value="dark">Black</SelectItem>
        <SelectItem value="dark-blue">Dark Blue</SelectItem>
      </SelectContent>
    </Select>
  );
}
