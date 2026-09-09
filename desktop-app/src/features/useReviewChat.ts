import { useStudio } from "../state/StudioContext";
import { useChapterTask } from "./useChapterTask";
export function useReviewChat() {
  const s = useStudio(),
    task = useChapterTask();
  const review = task?.status === "awaiting_input" ? task.review : null;
  const question = review?.issues.find(
    (i) => !review.answers?.some((a) => a.issueId === i.id),
  );
  async function answer(text: string, optionId = "custom") {
    if (!task || !review || !question) return false;
    return s.generate(text || "回答情节确认", {
      resume: true,
      decision: {
        taskId: task.id,
        pendingId: review.id,
        choices: [
          {
            issueId: question.id,
            optionId,
            ...(text.trim() ? { instruction: text.trim() } : {}),
          },
        ],
      },
    });
  }
  return {
    task,
    question,
    questionId:
      review && question ? `review-${review.id}-${question.id}` : null,
    answer,
  };
}
