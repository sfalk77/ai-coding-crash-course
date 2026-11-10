import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/instructor";
import {
  getInstructorAnalytics,
  type InstructorAnalytics,
} from "~/services/analyticsService";
import { getCurrentUserId } from "~/lib/session";
import { getUserById } from "~/services/userService";
import { Card, CardContent, CardFooter, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { AlertTriangle, BookOpen, GraduationCap, Plus, Users } from "lucide-react";
import { CourseImage } from "~/components/course-image";
import { data, isRouteErrorResponse } from "react-router";
import { CourseStatus, UserRole } from "~/db/schema";

export function meta() {
  return [
    { title: "My Courses — Cadence" },
    { name: "description", content: "Manage your courses" },
  ];
}

const RANGES = {
  all: { label: "All time", days: null },
  "30d": { label: "Last 30 days", days: 30 },
} as const;

type Range = keyof typeof RANGES;

/** Missing or unknown values fall back to all time. */
function parseRange(value: string | null): Range {
  return value !== null && Object.hasOwn(RANGES, value) ? (value as Range) : "all";
}

function cutoffFor(range: Range, now = new Date()): Date | undefined {
  const { days } = RANGES[range];
  if (days === null) return undefined;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function loader({ request, url }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view your courses.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (!user || user.role !== UserRole.Instructor) {
    throw data("Only instructors can access this page.", {
      status: 403,
    });
  }

  const range = parseRange(url.searchParams.get("range"));

  // One call feeds both the analytics section and the course cards,
  // using grouped queries instead of one query per course.
  return {
    range,
    analytics: getInstructorAnalytics(currentUserId, cutoffFor(range)),
  };
}

function statusBadge(status: string) {
  switch (status) {
    case CourseStatus.Published:
      return (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
          Published
        </Badge>
      );
    case CourseStatus.Draft:
      return (
        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
          Draft
        </Badge>
      );
    case CourseStatus.Archived:
      return <Badge variant="secondary">Archived</Badge>;
    default:
      return null;
  }
}

function RangeToggle({ range }: { range: Range }) {
  const [searchParams] = useSearchParams();

  return (
    <div
      role="group"
      aria-label="Date range"
      className="inline-flex rounded-md border bg-muted p-0.5"
    >
      {(Object.keys(RANGES) as Range[]).map((value) => {
        const params = new URLSearchParams(searchParams);
        if (value === "all") params.delete("range");
        else params.set("range", value);
        const query = params.toString();
        const active = value === range;

        return (
          <Link
            key={value}
            to={query ? `?${query}` : "."}
            replace
            preventScrollReset
            aria-current={active ? "true" : undefined}
            className={
              "rounded px-3 py-1 text-sm font-medium transition-colors " +
              (active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {RANGES[value].label}
          </Link>
        );
      })}
    </div>
  );
}

function AnalyticsSection({
  analytics,
  range,
}: {
  analytics: InstructorAnalytics;
  range: Range;
}) {
  const { students, newEnrollments } = analytics.totals;
  const windowed = newEnrollments !== null;

  return (
    <section aria-labelledby="analytics-heading" className="mb-10 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="analytics-heading" className="text-xl font-semibold">
          Analytics
        </h2>
        <RangeToggle range={range} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="gap-2">
          <CardHeader className="flex flex-row items-center justify-between pb-0">
            <span className="text-sm font-medium text-muted-foreground">
              {windowed ? "New enrollments" : "Students"}
            </span>
            <Users className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {windowed ? newEnrollments : students}
            </div>
            <p className="text-xs text-muted-foreground">
              {windowed
                ? `${students} distinct students in total`
                : "Distinct students across all courses"}
            </p>
          </CardContent>
        </Card>
      </div>
      {analytics.courses.length > 0 && (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Course</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6 text-right">
                  {windowed ? "New enrollments" : "Students"}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics.courses.map((row) => (
                <TableRow key={row.courseId}>
                  <TableCell className="pl-6 font-medium">
                    <Link
                      to={`/instructor/${row.courseId}`}
                      className="hover:text-primary"
                    >
                      {row.title}
                    </Link>
                  </TableCell>
                  <TableCell>{statusBadge(row.status)}</TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">
                    {windowed ? (
                      <>
                        {row.newEnrollmentCount}
                        <span className="ml-1 text-xs text-muted-foreground">
                          / {row.studentCount} students
                        </span>
                      </>
                    ) : (
                      row.studentCount
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="mt-2 h-5 w-72" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="flex flex-col">
            <Skeleton className="aspect-video rounded-b-none rounded-t-lg" />
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
            </CardHeader>
            <CardContent className="flex-1">
              <div className="flex items-center gap-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-20" />
              </div>
            </CardContent>
            <CardFooter>
              <Skeleton className="h-10 w-full" />
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function InstructorDashboard({
  loaderData,
}: Route.ComponentProps) {
  const { analytics, range } = loaderData;
  const courses = analytics.courses;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">My Courses</span>
      </nav>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">My Courses</h1>
          <p className="mt-1 text-muted-foreground">
            Manage your courses and track enrollments
          </p>
        </div>
        <Link to="/instructor/new">
          <Button>
            <Plus className="mr-2 size-4" />
            New Course
          </Button>
        </Link>
      </div>

      <AnalyticsSection analytics={analytics} range={range} />

      {courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first course to get started.
          </p>
          <Link to="/instructor/new" className="mt-4">
            <Button>
              <Plus className="mr-2 size-4" />
              Create Course
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <Card key={course.courseId} className="flex flex-col overflow-hidden pt-0">
              <Link to={`/courses/${course.slug}`} className="aspect-video overflow-hidden">
                <CourseImage
                  src={course.coverImageUrl}
                  alt={course.title}
                  className="h-full w-full object-cover transition-transform hover:scale-105"
                />
              </Link>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <Link
                    to={`/courses/${course.slug}`}
                    className="text-lg font-semibold leading-tight hover:text-primary"
                  >
                    {course.title}
                  </Link>
                  {statusBadge(course.status)}
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {course.description}
                </p>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <BookOpen className="size-4" />
                    <span>
                      {course.lessonCount}{" "}
                      {course.lessonCount === 1 ? "lesson" : "lessons"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Users className="size-4" />
                    <span>
                      {course.studentCount}{" "}
                      {course.studentCount === 1 ? "student" : "students"}
                    </span>
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Link to={`/instructor/${course.courseId}`} className="w-full">
                  <Button className="w-full" variant="outline">
                    <BookOpen className="mr-2 size-4" />
                    Edit Course
                  </Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your courses.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "You don't have permission to access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
