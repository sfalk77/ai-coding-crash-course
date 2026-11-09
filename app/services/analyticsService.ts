import { count, countDistinct, eq } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, lessons, modules } from "~/db/schema";

/**
 * Analytics across all of one instructor's courses (every status).
 * Each metric is a single grouped aggregate query — never one query per course.
 */
export function getInstructorAnalytics(instructorId: number) {
  const ownCourse = eq(courses.instructorId, instructorId);

  const instructorCourses = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      description: courses.description,
      coverImageUrl: courses.coverImageUrl,
      status: courses.status,
    })
    .from(courses)
    .where(ownCourse)
    .orderBy(courses.title)
    .all();

  const studentCounts = db
    .select({
      courseId: enrollments.courseId,
      count: countDistinct(enrollments.userId),
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(ownCourse)
    .groupBy(enrollments.courseId)
    .all();

  const lessonCounts = db
    .select({ courseId: modules.courseId, count: count(lessons.id) })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(ownCourse)
    .groupBy(modules.courseId)
    .all();

  // Distinct across all courses: a student in two courses counts once.
  const totalStudents = db
    .select({ count: countDistinct(enrollments.userId) })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(ownCourse)
    .get();

  const studentsByCourse = byCourse(studentCounts);
  const lessonsByCourse = byCourse(lessonCounts);

  return {
    totals: { students: totalStudents?.count ?? 0 },
    courses: instructorCourses.map((course) => ({
      courseId: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      coverImageUrl: course.coverImageUrl,
      status: course.status,
      lessonCount: lessonsByCourse.get(course.id) ?? 0,
      studentCount: studentsByCourse.get(course.id) ?? 0,
    })),
  };
}

export type InstructorAnalytics = ReturnType<typeof getInstructorAnalytics>;

function byCourse(rows: { courseId: number; count: number }[]) {
  return new Map(rows.map((r) => [r.courseId, r.count]));
}
