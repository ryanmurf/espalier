export interface PlaygroundExample {
  id: string;
  title: string;
  description: string;
  category: string;
  code: string;
  difficulty: "beginner" | "intermediate" | "advanced";
}
